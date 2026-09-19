import { ActivityIndicator, StyleSheet } from 'react-native';

import { ThemedView } from '@/components/themed-view';

/** Full-screen spinner, shown while the stored session is being read back. */
export function ScreenLoader() {
  return (
    <ThemedView style={styles.container}>
      <ActivityIndicator />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
