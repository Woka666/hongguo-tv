package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
)

type searchTestTransport func(*http.Request) (*http.Response, error)

func (f searchTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestSearchRegistrationFailureFallsBackAndWebContinuationSkipsRegistration(t *testing.T) {
	registrations, appSearches, webSearches := 0, 0, 0
	accounts := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected App request") })
	accounts.newClient = func(session accountSession) *passportClient {
		c := newPassportClient(session)
		c.http.Transport = searchTestTransport(func(r *http.Request) (*http.Response, error) {
			if r.URL.Path == "/service/2/device_register/" {
				registrations++
			} else {
				appSearches++
			}
			return nil, &net.DNSError{Err: "blocked by test DNS", Name: "log.snssdk.com"}
		})
		return c
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		webSearches++
		if r.URL.Path != "/api/search/result" || r.URL.Query().Get("query") != "万妖" {
			t.Errorf("unexpected Web request: %s", r.URL.Path)
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Tt-Token") != "" || r.URL.Query().Get("device_id") != "" {
			t.Error("Web fallback leaked App identity")
		}
		page := 1
		if webSearches == 2 {
			page = 2
			if r.URL.Query().Get("page") != "2" || r.URL.Query().Get("passback") != "" {
				t.Error("Web continuation lost its page or reused an App cursor")
			}
		}
		ioJSON(w, fmt.Sprintf(`{"searchList":[{"video_data":{"series_id":"769016327621417679%d","series_title":"第%d页","episode_cnt":10}}],"totalCount":"2","pageNum":%d,"totalPages":2,"hasMore":%t}`, page, page, page, page == 1))
	}))
	defer upstream.Close()
	hongguo := newHongguoClient()
	hongguo.webBase, hongguo.httpClient = upstream.URL, upstream.Client()
	// Even a preconfigured cookie jar must not attach account cookies to search.
	jar, _ := cookiejar.New(nil)
	u, _ := url.Parse(upstream.URL)
	jar.SetCookies(u, []*http.Cookie{{Name: "sessionid", Value: "private-test-cookie"}})
	hongguo.httpClient.Jar = jar
	s := &server{accounts: accounts, hongguo: hongguo}
	for page, path := range []string{"/api/v1/lists/search?q=万妖", "/api/v1/lists/search?q=万妖&source=web&offset=1&passback=app-cursor"} {
		w := httptest.NewRecorder()
		s.lists(w, httptest.NewRequest(http.MethodGet, path, nil))
		var payload struct {
			Data ListResult `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if w.Code != http.StatusOK || payload.Data.Source != "web" || len(payload.Data.Items) != 1 || payload.Data.NextOffset != page+1 || payload.Data.HasMore != (page == 0) {
			t.Fatalf("bad page %d: HTTP %d %s", page+1, w.Code, w.Body.String())
		}
	}
	if registrations != 1 || appSearches != 0 || webSearches != 2 {
		t.Fatalf("registration=%d app=%d web=%d", registrations, appSearches, webSearches)
	}
}

func TestAppSearchContinuationNeverSwitchesToWeb(t *testing.T) {
	accounts := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/service/2/device_register/" {
			ioJSON(w, `{"device_id_str":"7391234567890123456","install_id_str":"7391234567890123457"}`)
		} else if r.URL.Query().Get("offset") == "20" {
			w.WriteHeader(http.StatusBadGateway)
		} else {
			ioJSON(w, `{"code":0,"search_tabs":[{"tab_type":11,"has_more":true,"next_offset":20,"data":[{"video_data":[{"series_id":"7690163276214176792","title":"App结果","episode_cnt":10}]}]}]}`)
		}
	})
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("App continuation switched source") }))
	defer web.Close()
	hongguo := newHongguoClient()
	hongguo.webBase = web.URL
	s := &server{accounts: accounts, hongguo: hongguo}
	for _, tc := range []struct {
		path string
		code int
	}{{"/api/v1/lists/search?q=测试", 200}, {"/api/v1/lists/search?q=测试&source=app&offset=20", 502}} {
		w := httptest.NewRecorder()
		s.lists(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if w.Code != tc.code {
			t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
		}
	}
}

func TestWebSearchRejectsStaleAccountAndInvalidParameters(t *testing.T) {
	accounts := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) { t.Error("explicit Web search requested registration") })
	webCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		webCalls++
		accounts.mu.Lock()
		accounts.generation++
		accounts.mu.Unlock()
		ioJSON(w, `{"searchList":[],"pageNum":1,"totalPages":0,"hasMore":false}`)
	}))
	defer upstream.Close()
	hongguo := newHongguoClient()
	hongguo.webBase = upstream.URL
	s := &server{accounts: accounts, hongguo: hongguo}
	for _, path := range []string{"/api/v1/lists/search?q=&source=web", "/api/v1/lists/search?q=test&source=bad", "/api/v1/lists/search?q=test&source=web&offset=-1"} {
		w := httptest.NewRecorder()
		s.lists(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != 400 || webCalls != 0 {
			t.Fatalf("invalid search reached upstream: %d %s", w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	s.lists(w, httptest.NewRequest(http.MethodGet, "/api/v1/lists/search?q=test&source=web", nil))
	if w.Code != 409 || webCalls != 1 {
		t.Fatalf("stale account results were accepted: %d %s", w.Code, w.Body.String())
	}
}

func TestWebSearchCancellationAndUpstreamFailures(t *testing.T) {
	for _, tc := range []struct {
		name, body, contentType, want string
		status                        int
	}{
		{"verification", `{"code":"search_verification_required"}`, "application/json", "需要图形验证", 403},
		{"forbidden", `{}`, "application/json", "HTTP 403", 403},
		{"server failure", `{}`, "application/json", "HTTP 503", 503},
		{"HTML", `<html>check</html>`, "text/html", "非 JSON", 200},
		{"wrong page", `{"searchList":[],"pageNum":1,"totalPages":2,"hasMore":true}`, "application/json", "分页信息", 200},
		{"missing results", `{"message":"failed"}`, "application/json", "分页信息", 200},
		{"trailing JSON", `{} {}`, "application/json", "有效 JSON", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Content-Type", tc.contentType)
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer upstream.Close()
			c := newHongguoClient()
			c.webBase = upstream.URL
			_, err := c.SearchPage(context.Background(), "test", 2)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
			wantCalls := 1
			if tc.status >= 500 {
				wantCalls = 2
			}
			if calls != wantCalls {
				t.Fatalf("unexpected retry count: %d", calls)
			}
		})
	}
	c := newHongguoClient()
	c.httpClient.Transport = searchTestTransport(func(*http.Request) (*http.Response, error) {
		t.Error("cancelled search reached transport")
		return nil, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := c.SearchPage(ctx, "test", 1)
	if err != context.Canceled {
		t.Fatalf("cancelled request: %v", err)
	}
}

func TestWebSearchRetriesTransientFailureOnTheSamePage(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Query().Get("page") != "2" || r.URL.Query().Get("query") != "万妖" {
			t.Error("retry changed search page or query")
		}
		if calls == 1 {
			w.WriteHeader(503)
			return
		}
		ioJSON(w, `{"searchList":[],"pageNum":2,"totalPages":2,"hasMore":false}`)
	}))
	defer upstream.Close()
	c := newHongguoClient()
	c.webBase = upstream.URL
	if out, err := c.SearchPage(context.Background(), "万妖", 2); err != nil || out.NextOffset != 2 || calls != 2 {
		t.Fatalf("same-page retry failed: %+v %v calls=%d", out, err, calls)
	}
}

func TestWebSearchNormalizationAndEmptyPage(t *testing.T) {
	page, err := parseWebSearchPage([]byte(`{"searchList":[{"video_data":{"series_id":7690163276214176792,"series_title":"真实剧集","episode_cnt":12}},{"video_data":{"series_id":"7690163276214176792","series_title":"重复"}},{"user_info":{"id":"7690163276214176793"}},{"video_data":{"series_id":"0"}}],"pageNum":1,"totalPages":1,"totalCount":"1","hasMore":true}`), 1)
	if err != nil || len(page.Items) != 1 || page.Items[0].SeriesID != "7690163276214176792" || page.HasMore {
		t.Fatalf("normalization failed: %+v %v", page, err)
	}
	page, err = parseWebSearchPage([]byte(`{"searchList":[],"pageNum":1,"totalPages":0,"totalCount":"0","hasMore":false}`), 1)
	if err != nil || page.Items == nil || len(page.Items) != 0 || page.HasMore {
		t.Fatalf("empty page failed: %+v %v", page, err)
	}
}

func TestWebSearchUsesIndependentHTTP1TransportWithoutChangingOtherClients(t *testing.T) {
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 1 || !r.Close {
			t.Errorf("website search reused the default protocol/connection: %s close=%v", r.Proto, r.Close)
		}
		ioJSON(w, `{"searchList":[],"pageNum":1,"totalPages":0,"hasMore":false}`)
	}))
	upstream.EnableHTTP2 = true
	upstream.StartTLS()
	defer upstream.Close()
	c := newHongguoClient()
	c.webBase, c.httpClient = upstream.URL, upstream.Client()
	transport := c.httpClient.Transport.(*http.Transport)
	transport.ForceAttemptHTTP2 = true
	transport.TLSClientConfig.NextProtos = []string{"h2", "http/1.1"}
	if _, err := c.SearchPage(context.Background(), "测试", 1); err != nil {
		t.Fatal(err)
	}
	if c.httpClient.Transport != transport || transport.DisableKeepAlives || !transport.ForceAttemptHTTP2 || !reflect.DeepEqual(transport.TLSClientConfig.NextProtos, []string{"h2", "http/1.1"}) {
		t.Fatal("website search changed the shared API/media transport")
	}
}

// Opt-in, anonymous GET only: no account data, registration, SMS, or media.
func TestLiveWebSearchJSONPagination(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_WEB_SEARCH") != "1" {
		t.Skip("anonymous Web JSON search probe")
	}
	registrations := 0
	accounts := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected App request") })
	accounts.newClient = func(session accountSession) *passportClient {
		c := newPassportClient(session)
		c.http.Transport = searchTestTransport(func(*http.Request) (*http.Response, error) {
			registrations++
			return nil, &net.DNSError{Err: "simulated blocked registration", Name: "log.snssdk.com"}
		})
		return c
	}
	s := &server{accounts: accounts, hongguo: newHongguoClient()}
	seen := map[string]bool{}
	for page := 1; page <= 2; page++ {
		query := url.Values{"q": {"万妖"}}
		if page > 1 {
			query.Set("source", "web")
			query.Set("offset", fmt.Sprint(page-1))
		}
		w := httptest.NewRecorder()
		s.lists(w, httptest.NewRequest(http.MethodGet, "/api/v1/lists/search?"+query.Encode(), nil))
		var payload struct {
			Data ListResult `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		out := payload.Data
		if w.Code != 200 || len(out.Items) == 0 || out.Source != "web" || out.NextOffset != page {
			t.Fatalf("page %d: HTTP %d: %s", page, w.Code, w.Body.String())
		}
		added := 0
		for _, item := range out.Items {
			if !seen[item.SeriesID] {
				added++
			}
			seen[item.SeriesID] = true
		}
		if added == 0 {
			t.Fatalf("page %d repeated previous results", page)
		}
		t.Logf("page=%d items=%d new=%d has_more=%v", page, len(out.Items), added, out.HasMore)
	}
	if registrations != 1 {
		t.Fatalf("Web continuation retried broken App registration: %d", registrations)
	}
}
