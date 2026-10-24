package rocks.aston.hongguotv;

import org.junit.Test;

import static org.junit.Assert.*;

public class Media3RoutePreferencePolicyTest {
    @Test
    public void matchesOnlyTheSameWebViewAndUnexpiredMedia3Route() {
        assertTrue(Media3RoutePreferencePolicy.matches("media3", "122.0.6261.94", "122.0.6261.94", 5000, 4999));
        assertFalse(Media3RoutePreferencePolicy.matches("html5", "122.0.6261.94", "122.0.6261.94", 5000, 4999));
        assertFalse(Media3RoutePreferencePolicy.matches("media3", "122.0.6261.94", "123.0.6312.80", 5000, 4999));
        assertFalse(Media3RoutePreferencePolicy.matches("media3", "122.0.6261.94", "122.0.6261.94", 5000, 5000));
    }

    @Test
    public void acceptsReasonableVersionStringsAndBoundsPreferenceLifetime() {
        assertTrue(Media3RoutePreferencePolicy.validWrite("122.0.6261.94", 1000 + 30L * 24L * 60L * 60L * 1000L, 1000));
        assertFalse(Media3RoutePreferencePolicy.validWrite("", 2000, 1000));
        assertFalse(Media3RoutePreferencePolicy.validWrite("122.bad", 2000, 1000));
        assertFalse(Media3RoutePreferencePolicy.validWrite("122.0", 999, 1000));
        assertFalse(Media3RoutePreferencePolicy.validWrite("122.0", 1000 + 32L * 24L * 60L * 60L * 1000L, 1000));
    }
}
