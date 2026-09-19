import { Redirect } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ScreenLoader } from '@/components/screen-loader';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

type Mode = 'signIn' | 'signUp';

export default function SignInScreen() {
  const theme = useTheme();
  const { session, isRestoring } = useAuth();

  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (isRestoring) {
    return <ScreenLoader />;
  }

  // No imperative navigation on success. A completed sign-in updates the session,
  // which re-renders this screen, which redirects - so there is no race between
  // "auth finished" and "navigate".
  if (session) {
    return <Redirect href="/houses" />;
  }

  const isSignUp = mode === 'signUp';

  function switchMode() {
    setMode(isSignUp ? 'signIn' : 'signUp');
    setError(null);
    setNotice(null);
  }

  async function submit() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Enter an email and password.');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      if (isSignUp) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: trimmedEmail,
          password,
        });

        if (signUpError) {
          setError(signUpError.message);
        } else if (!data.session) {
          // Supabase returns no session when email confirmation is switched on.
          // Without this the button would appear to do nothing at all.
          setNotice('Check your email to confirm your account, then sign in.');
          setMode('signIn');
        }
        // If a session did come back, the auth listener redirects us.
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });

        if (signInError) {
          setError(signInError.message);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({ provider: 'google' });
      if (oauthError) {
        setError(oauthError.message);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start Google sign-in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag">
          <View style={styles.content}>
            <View style={styles.header}>
              <ThemedText type="subtitle">{isSignUp ? 'Create account' : 'Sign in'}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {isSignUp
                  ? 'Set up an account to start tracking your home games.'
                  : 'Welcome back.'}
              </ThemedText>
            </View>

            {isSupabaseConfigured ? null : (
              <View style={[styles.banner, { backgroundColor: theme.backgroundElement }]}>
                <ThemedText type="smallBold">Supabase is not configured</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  Copy .env.example to .env, fill in the project URL and anon key, then
                  restart the dev server. They are inlined at build time, so a reload is
                  not enough.
                </ThemedText>
              </View>
            )}

            <View style={styles.form}>
              <Field label="Email">
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={theme.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  keyboardType="email-address"
                  inputMode="email"
                  editable={!busy}
                  style={[
                    styles.input,
                    { color: theme.text, backgroundColor: theme.backgroundElement },
                  ]}
                />
              </Field>

              <Field label="Password">
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder={isSignUp ? 'At least 6 characters' : 'Your password'}
                  placeholderTextColor={theme.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete={isSignUp ? 'new-password' : 'current-password'}
                  textContentType={isSignUp ? 'newPassword' : 'password'}
                  secureTextEntry
                  editable={!busy}
                  onSubmitEditing={submit}
                  returnKeyType="go"
                  style={[
                    styles.input,
                    { color: theme.text, backgroundColor: theme.backgroundElement },
                  ]}
                />
              </Field>

              {error ? (
                <ThemedText type="small" style={styles.error}>
                  {error}
                </ThemedText>
              ) : null}

              {notice ? (
                <ThemedText type="small" themeColor="textSecondary">
                  {notice}
                </ThemedText>
              ) : null}

              <Button
                label={isSignUp ? 'Create account' : 'Sign in'}
                onPress={submit}
                busy={busy}
                disabled={!isSupabaseConfigured}
              />

              <Pressable onPress={switchMode} disabled={busy} accessibilityRole="button">
                <ThemedText type="small" themeColor="textSecondary" style={styles.switch}>
                  {isSignUp ? 'Already have an account? Sign in' : 'New here? Create an account'}
                </ThemedText>
              </Pressable>
            </View>

            <View style={styles.divider}>
              <View style={[styles.rule, { backgroundColor: theme.backgroundSelected }]} />
              <ThemedText type="small" themeColor="textSecondary">
                or
              </ThemedText>
              <View style={[styles.rule, { backgroundColor: theme.backgroundSelected }]} />
            </View>

            <Button
              label="Continue with Google"
              variant="secondary"
              onPress={signInWithGoogle}
              disabled={busy || !isSupabaseConfigured}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <ThemedText type="smallBold">{label}</ThemedText>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: Spacing.four,
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.five,
  },
  header: { gap: Spacing.two },
  form: { gap: Spacing.three },
  field: { gap: Spacing.two },
  input: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
  },
  error: { color: '#d92d20' },
  switch: { textAlign: 'center' },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  banner: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: 12,
  },
});
