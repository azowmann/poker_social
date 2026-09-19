import { Redirect } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ScreenLoader } from '@/components/screen-loader';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

/**
 * Step 3 of the screen flow: the houses a player belongs to.
 *
 * Slice 1 is the shell only - the list is not wired to the database yet, so the
 * empty state is unconditional. Slice 2 replaces it with a query over
 * `memberships`, which RLS already scopes to the signed-in user.
 */
export default function HousesScreen() {
  const theme = useTheme();
  const { session, isRestoring } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  if (isRestoring) {
    return <ScreenLoader />;
  }

  if (!session) {
    return <Redirect href="/sign-in" />;
  }

  async function signOut() {
    setSigningOut(true);
    // No navigation here either: clearing the session re-renders this screen and
    // the guard above sends us to sign-in.
    await supabase.auth.signOut();
    setSigningOut(false);
  }

  return (
    <SafeAreaView
      edges={['bottom']}
      style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <View style={styles.content}>
        <View style={styles.empty}>
          <ThemedText type="default" style={styles.emptyTitle}>
            No houses yet
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.emptyBody}>
            Start or join one.
          </ThemedText>
        </View>

        <View style={styles.footer}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.account}>
            Signed in as {session.user.email ?? 'your account'}
          </ThemedText>
          <Button label="Sign out" variant="secondary" onPress={signOut} busy={signingOut} />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.four,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  emptyTitle: { fontWeight: '600' },
  emptyBody: { textAlign: 'center' },
  footer: { gap: Spacing.three },
  account: { textAlign: 'center' },
});
