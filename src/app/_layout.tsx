import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider } from '@/lib/auth';

SplashScreen.preventAutoHideAsync();

/**
 * Root layout.
 *
 * Auth routing is deliberately NOT done here. The launch decision lives in
 * `index.tsx` and each screen guards itself with a `<Redirect>`, so there is no
 * window where a screen renders before the session is known. This layout only
 * provides the session to everything below it.
 *
 * `AnimatedSplashOverlay` owns `SplashScreen.hideAsync()` - keep it mounted or the
 * native splash never lifts.
 */
export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <AnimatedSplashOverlay />
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          <Stack.Screen name="houses" options={{ title: 'Your Houses' }} />
        </Stack>
      </AuthProvider>
    </ThemeProvider>
  );
}
