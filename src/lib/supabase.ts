/**
 * The Supabase client. One instance for the whole app - import `supabase` from
 * here rather than calling createClient anywhere else, so there is a single auth
 * session and a single set of listeners.
 *
 * The session is the only thing this app keeps on the device (CLAUDE.md: "Local
 * storage: session token only"), held in AsyncStorage so a returning player skips
 * the login screen.
 *
 * Every query made through this client runs as the signed-in user and is filtered
 * by Row Level Security. The service-role key is deliberately absent - it must
 * never ship in the app.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

// EXPO_PUBLIC_* is inlined into the bundle at build time, which is correct for
// both of these: the project URL and the anon key are publishable. They identify
// the project, they do not grant access - RLS decides what a caller may read.
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Whether both env vars were present at build time. Screens check this and
 * explain what to do, rather than letting every request fail as a vague network
 * error.
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
  // Deliberately not `throw`. `web.output: "static"` prerenders the app at build
  // time, so throwing here fails the bundle instead of the request - and on a
  // device it would be a red-box crash rather than something a person can act on.
  console.warn(
    '[supabase] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are not ' +
      'set. Copy .env.example to .env and restart the dev server - these are ' +
      'inlined at build time, so a reload is not enough.'
  );
}

/**
 * `web.output: "static"` prerenders the app in Node at build time, where there is
 * no `window` - and AsyncStorage's web implementation reads `window.localStorage`
 * the moment Supabase restores a session. React Native defines `window`, and so
 * does a browser, so this is false only during that prerender pass, where an
 * in-memory session is exactly right.
 */
const canPersistSession = typeof window !== 'undefined';

export const supabase = createClient(
  // createClient rejects an empty URL outright, so stand in something valid and
  // unreachable. Nothing can succeed against it, and isSupabaseConfigured is what
  // the UI actually keys off.
  supabaseUrl ?? 'http://supabase-not-configured.invalid',
  supabaseAnonKey ?? 'supabase-not-configured',
  {
    auth: {
      storage: canPersistSession ? AsyncStorage : undefined,
      persistSession: canPersistSession,
      autoRefreshToken: canPersistSession,
      // Native apps have no URL bar to read a session out of. The OAuth redirect is
      // handled explicitly by the sign-in screen via expo-linking instead.
      detectSessionInUrl: Platform.OS === 'web' && canPersistSession,
    },
  }
);

// Supabase only refreshes the access token while the app is in the foreground.
// Without this the token can expire in the background and the next query 401s.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (status) => {
    if (status === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}
