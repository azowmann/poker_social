import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  variant?: 'primary' | 'secondary';
  /** Shows a spinner in place of the label and blocks presses. */
  busy?: boolean;
};

export function Button({ label, variant = 'primary', busy, disabled, ...rest }: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || busy;

  const isPrimary = variant === 'primary';
  const background = isPrimary ? theme.text : theme.backgroundElement;
  const foreground = isPrimary ? theme.background : theme.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!busy }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background },
        pressed && styles.pressed,
        isDisabled && styles.disabled,
      ]}
      {...rest}>
      {busy ? (
        <ActivityIndicator color={foreground} />
      ) : (
        // Keeps the label vertically centred against the spinner's height.
        <View style={styles.labelRow}>
          <ThemedText style={[styles.label, { color: foreground }]}>{label}</ThemedText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelRow: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.8,
  },
  disabled: {
    opacity: 0.5,
  },
});
