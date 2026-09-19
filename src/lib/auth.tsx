/**
 * Auth session state for the whole app.
 *
 * Supabase already persists the session to AsyncStorage (see `@/lib/supabase`);
 * this exposes it to React and keeps it current. Two things feed it:
 *
 *   - `getSession()` once on mount, which reads the stored session back from disk.
 *     This is the "skip login if we have a session" step from ARCHITECTURE.md.
 *   - `onAuthStateChange`, which fires on sign-in, sign-out, and token refresh.
 *
 * Screens never call `supabase.auth` to find out who is signed in - they read
 * `useAuth()`, so there is one answer everywhere.
 */
import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { supabase } from '@/lib/supabase';

type AuthState = {
  session: Session | null;
  /**
   * True until the stored session has been read back. Screens must wait for this
   * before deciding where to send the user, or a returning player gets bounced to
   * the sign-in screen for a frame before landing on their houses.
   */
  isRestoring: boolean;
};

const AuthContext = createContext<AuthState>({ session: null, isRestoring: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setIsRestoring(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      // A sign-out event can arrive before getSession() resolves; either way the
      // question of "is there a session" is now answered.
      setIsRestoring(false);
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={{ session, isRestoring }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
