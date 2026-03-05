import { Panel } from './Panel';
import { LiveNewsPanel } from './LiveNewsPanel';
import { ObsOverlay } from './ObsOverlay';

// ... existing imports ...

export const PANEL_REGISTRY: Record<string, typeof Panel> = {
  // ... existing panel registrations ...
  LiveNewsPanel,
  ObsOverlay,
  // ... rest of the existing registrations ...
};
