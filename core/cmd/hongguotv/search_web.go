package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var errSearchParameters = errors.New("搜索参数无效")

// App cursors and website page numbers belong to different result sets. Only
// the first page may choose a fallback; every continuation keeps its source.
func (s *server) searchList(ctx context.Context, q url.Values) (ListResult, uint64, error) {
	client, generation, err := s.accounts.listClient(false)
	if err != nil {
		return ListResult{}, generation, err
	}
	query, source := strings.TrimSpace(q.Get("q")), q.Get("source")
	if query == "" || len([]rune(query)) > 80 || source != "" && source != "app" && source != "web" {
		return ListResult{}, generation, errSearchParameters
	}
	offset := asInt(q.Get("offset")) // Validated by listQuery before dispatch.
	if source == "web" {
		out, err := s.hongguo.SearchPage(ctx, query, offset+1)
		return out, generation, err
	}
	err = s.accounts.ensureDeviceRegistered(ctx, client, generation)
	if err == nil {
		var out ListResult
		out, err = client.SearchList(ctx, q)
		if err == nil {
			return out, generation, nil
		}
	}
	if ctx.Err() != nil {
		return ListResult{}, generation, ctx.Err()
	}
	if !s.accounts.sameGeneration(generation) || errors.Is(err, errAccountChanged) || source == "app" || offset != 0 {
		return ListResult{}, generation, err
	}
	// Registration failure must reach this path as well. The website request
	// never uses the App identity, account cookies, token, or App signature.
	out, webErr := s.hongguo.SearchPage(ctx, query, 1)
	if webErr != nil {
		return ListResult{}, generation, fmt.Errorf("App 搜索失败：%v；官网搜索失败：%w", err, webErr)
	}
	return out, generation, nil
}

// SearchPage uses the website's JSON result endpoint, not the suggestion
// endpoint or the HTML loader data. Its offset is the number of pages already
// consumed: next_offset=1 means page=2 when source=web.
func (c *hongguoClient) SearchPage(ctx context.Context, query string, page int) (ListResult, error) {
	if err := ctx.Err(); err != nil {
		return ListResult{}, err
	}
	query = strings.TrimSpace(query)
	if query == "" || len([]rune(query)) > 80 || page < 1 || page > 100001 {
		return ListResult{}, errSearchParameters
	}
	endpoint := c.webBase + "/api/search/result?query=" + url.QueryEscape(query)
	if page > 1 {
		endpoint += "&page=" + strconv.Itoa(page)
	}
	// Bound this independent fallback without changing other API/media clients.
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	client := *c.httpClient
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// The live website stalled on a default-transport continuation while
	// independent HTTP/1.1 requests returned both pages. Scope this transport
	// to website search only; App APIs, suggestions and media retain theirs.
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	if transport, ok := base.(*http.Transport); ok {
		transport = transport.Clone()
		transport.ForceAttemptHTTP2 = false
		transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
		if transport.TLSClientConfig == nil {
			transport.TLSClientConfig = &tls.Config{}
		}
		transport.TLSClientConfig.NextProtos = []string{"http/1.1"}
		transport.DisableKeepAlives = true
		client.Transport = transport
		defer transport.CloseIdleConnections()
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		attemptCtx, stop := context.WithTimeout(ctx, 5*time.Second)
		out, err, retry := requestWebSearchPage(attemptCtx, &client, endpoint, c.webBase+"/", page)
		stop()
		if err == nil {
			return out, nil
		}
		if ctx.Err() != nil {
			return ListResult{}, ctx.Err()
		}
		lastErr = err
		if !retry || attempt == 1 {
			break
		}
		select {
		case <-ctx.Done():
			return ListResult{}, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return ListResult{}, lastErr
}

// Only transport/read failures and HTTP 5xx are retried. Validation, malformed
// data, and verification challenges must remain visible failures.
func requestWebSearchPage(ctx context.Context, client *http.Client, endpoint, referer string, page int) (ListResult, error, bool) {
	if err := ctx.Err(); err != nil {
		return ListResult{}, err, false
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return ListResult{}, errors.New("官网搜索地址无效"), false
	}
	request.Header.Set("User-Agent", "Mozilla/5.0 (Android TV; HongguoTV)")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Referer", referer)
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() == context.Canceled {
			return ListResult{}, context.Canceled, false
		}
		if ctx.Err() == context.DeadlineExceeded {
			return ListResult{}, errors.New("官网搜索连接超时，请重试"), true
		}
		return ListResult{}, errors.New("官网搜索连接失败，请重试"), true
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil {
		if ctx.Err() == context.Canceled {
			return ListResult{}, context.Canceled, false
		}
		return ListResult{}, errors.New("官网搜索响应读取失败，请重试"), true
	}
	if len(body) > 4<<20 {
		return ListResult{}, errors.New("官网搜索响应过大"), false
	}
	if response.StatusCode == http.StatusForbidden {
		var problem struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(body, &problem) == nil && problem.Code == "search_verification_required" {
			return ListResult{}, errors.New("官网搜索需要图形验证，暂时无法读取，请稍后重试"), false
		}
	}
	if response.StatusCode != http.StatusOK {
		return ListResult{}, fmt.Errorf("官网搜索返回 HTTP %d，请稍后重试", response.StatusCode), response.StatusCode >= 500 && response.StatusCode <= 599
	}
	if strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/html") {
		return ListResult{}, errors.New("官网搜索返回了非 JSON 页面，请稍后重试"), false
	}
	out, err := parseWebSearchPage(body, page)
	return out, err, false
}

func parseWebSearchPage(body []byte, page int) (ListResult, error) {
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if decoder.Decode(&payload) != nil || payload == nil || decoder.Decode(&struct{}{}) != io.EOF {
		return ListResult{}, errors.New("官网搜索响应不是有效 JSON")
	}
	rows, valid := payload["searchList"].([]any)
	more, hasMore := payload["hasMore"].(bool)
	pageNum := asInt(payload["pageNum"])
	totalPages := asInt(payload["totalPages"])
	if !valid || !hasMore || pageNum != page || totalPages < 0 {
		return ListResult{}, errors.New("官网搜索响应缺少有效的结果或分页信息")
	}
	items := make([]Drama, 0, len(rows))
	seen := make(map[string]bool)
	for _, row := range rows {
		object, ok := asMap(row)
		if !ok {
			continue
		}
		video, ok := asMap(object["video_data"])
		if !ok {
			continue // Actor/keyword results must not become playable drama cards.
		}
		drama, ok := normalizeDrama(video)
		if !ok || !validID(drama.SeriesID) || drama.SeriesID == "0" || seen[drama.SeriesID] {
			continue
		}
		seen[drama.SeriesID] = true
		items = append(items, drama)
	}
	return ListResult{CategoryResult: CategoryResult{
		Items: items, HasMore: more && len(rows) > 0 && (totalPages == 0 || page < totalPages), NextOffset: page,
	}, Source: "web"}, nil
}
