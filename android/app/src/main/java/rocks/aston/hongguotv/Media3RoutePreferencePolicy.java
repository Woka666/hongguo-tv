package rocks.aston.hongguotv;

final class Media3RoutePreferencePolicy {
    private static final long MAX_AGE_MS = 31L * 24L * 60L * 60L * 1000L;

    private Media3RoutePreferencePolicy() {}

    static boolean validWebViewVersion(String value) {
        return value != null && value.matches("[0-9]+(\\.[0-9]+){0,3}");
    }

    static boolean matches(String engine, String storedVersion, String requestedVersion, long expiresAt, long now) {
        return "media3".equals(engine) && validWebViewVersion(requestedVersion) &&
                requestedVersion.equals(storedVersion) && expiresAt > now;
    }

    static boolean validWrite(String webviewVersion, long expiresAt, long now) {
        return validWebViewVersion(webviewVersion) && expiresAt > now && expiresAt <= now + MAX_AGE_MS;
    }
}
