import { Redirect } from 'expo-router';

import { ScreenLoader } from '@/components/screen-loader';
import { useAuth } from '@/lib/auth';

/**
 * Launch gate - step 1 of the screen flow in ARCHITECTURE.md: "check for a saved
 * session; if present, skip login."
 *
 * Renders nothing of its own. It waits for the stored session to come back off
 * disk, then hands off to the right screen.
 */
export default function Index() {
  const { session, isRestoring } = useAuth();

  if (isRestoring) {
    return <ScreenLoader />;
  }

  return <Redirect href={session ? '/houses' : '/sign-in'} />;
}
