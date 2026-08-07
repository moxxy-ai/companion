import type { ReactNode } from 'react';
import { Slot } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';

/**
 * A provider's vendor mark, wherever a provider is named: the catalogue tile,
 * a connection card, a menu item that picks one reviewer over another. The
 * artwork belongs to the module that owns the provider and reaches here through
 * its slot, so nothing outside that module holds anyone's logo.
 */
export function ProviderIcon({
  providerId,
  fallback = null,
}: {
  providerId: string;
  /** Drawn when the owning module contributes no mark (or is disabled). */
  fallback?: ReactNode;
}): JSX.Element {
  const { can } = useAuth();
  return <Slot name={`integrations.provider.${providerId}.icon`} can={can} fallback={fallback} />;
}
