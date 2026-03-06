import { SITE_VARIANT } from '@/config/variant';
import { getCurrentLanguage } from '@/services/i18n';

interface DigestItem {
  title?: string;
  link?: string;
  source?: string;
  publishedAt?: string;
}

interface DigestCategory {
  items?: DigestItem[];
}

interface DigestResponse {
  categories?: Record<string, DigestCategory>;
}

interface OverlayHeadline {
  title: string;
  link: string;
  source: string;
  publishedAtMs: number;
}

interface OverlayPosition {
  left: number;
  top: number;
}

const POSITION_STORAGE_KEY = 'wm-obs-overlay-position-v1';
const VISIBLE_STORAGE_KEY = 'wm-obs-overlay-visible-v1';
const HEADLINES_STORAGE_KEY = 'wm-obs-overlay-headlines-v1';

const REFRESH_INTERVAL_MS = 60_000;
const TICKER_ADVANCE_MS = 4_000;
const CAROUSEL_ADVANCE_MS = 8_000;

export class ObsOverlay {
  public readonly element: HTMLElement;

  private readonly tickerTextEl: HTMLElement;
  private readonly carouselLinkEl: HTMLAnchorElement;
  private readonly carouselMetaEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly indexEl: HTMLElement;
  private readonly dragHandleEl: HTMLButtonElement;
  private readonly tickerAdvanceMs: number;
  private readonly carouselAdvanceMs: number;

  private headlines: OverlayHeadline[] = [];
  private tickerIndex = 0;
  private carouselIndex = 0;
  private isRefreshing = false;
  private isPausedForInteraction = false;

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private tickerTimer: ReturnType<typeof setInterval> | null = null;
  private carouselTimer: ReturnType<typeof setInterval> | null = null;

  private isDragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  constructor() {
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.tickerAdvanceMs = prefersReducedMotion ? 8_000 : TICKER_ADVANCE_MS;
    this.carouselAdvanceMs = prefersReducedMotion ? 12_000 : CAROUSEL_ADVANCE_MS;

    const container = document.createElement('aside');
    container.className = 'obs-overlay';
    container.setAttribute('aria-label', 'OBS Broadcast Overlay');

    const header = document.createElement('div');
    header.className = 'obs-overlay__header';

    const title = document.createElement('strong');
    title.className = 'obs-overlay__title';
    title.textContent = 'OBS Overlay';

    const controls = document.createElement('div');
    controls.className = 'obs-overlay__controls';

    this.indexEl = document.createElement('span');
    this.indexEl.className = 'obs-overlay__index';
    this.indexEl.textContent = '0/0';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'obs-overlay__close';
    closeButton.setAttribute('aria-label', 'Hide overlay');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => this.toggleVisibility(false));

    controls.append(this.indexEl, closeButton);

    this.dragHandleEl = document.createElement('button');
    this.dragHandleEl.type = 'button';
    this.dragHandleEl.className = 'obs-overlay__drag-handle';
    this.dragHandleEl.title = 'Drag overlay';
    this.dragHandleEl.setAttribute('aria-label', 'Drag overlay');
    this.dragHandleEl.textContent = '⋮⋮';

    header.append(title, controls, this.dragHandleEl);

    const ticker = document.createElement('div');
    ticker.className = 'obs-overlay__ticker';
    this.tickerTextEl = document.createElement('div');
    this.tickerTextEl.className = 'obs-overlay__ticker-text';
    this.tickerTextEl.textContent = 'Loading headlines…';
    this.tickerTextEl.setAttribute('role', 'status');
    this.tickerTextEl.setAttribute('aria-live', 'polite');
    ticker.appendChild(this.tickerTextEl);

    const carousel = document.createElement('div');
    carousel.className = 'obs-overlay__carousel';

    this.carouselLinkEl = document.createElement('a');
    this.carouselLinkEl.className = 'obs-overlay__headline';
    this.carouselLinkEl.href = '#';
    this.carouselLinkEl.target = '_blank';
    this.carouselLinkEl.rel = 'noopener noreferrer';
    this.carouselLinkEl.textContent = 'Waiting for updates…';

    this.carouselMetaEl = document.createElement('div');
    this.carouselMetaEl.className = 'obs-overlay__meta';
    this.carouselMetaEl.textContent = '—';

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'obs-overlay__status';
    this.statusEl.textContent = 'Initializing…';
    this.statusEl.setAttribute('aria-live', 'polite');

    carousel.append(this.carouselLinkEl, this.carouselMetaEl, this.statusEl);
    container.append(header, ticker, carousel);

    this.element = container;

    this.restorePosition();
    this.restoreVisibility();
    this.restoreHeadlines();
    this.attachDragHandlers();
    this.attachInteractionHandlers();
    window.addEventListener('resize', this.onWindowResize);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.startTimers();
    void this.refreshHeadlines();
  }

  public toggleVisibility(force?: boolean): void {
    const shouldShow = typeof force === 'boolean'
      ? force
      : this.element.classList.contains('obs-overlay--hidden');

    this.element.classList.toggle('obs-overlay--hidden', !shouldShow);
    try {
      localStorage.setItem(VISIBLE_STORAGE_KEY, shouldShow ? '1' : '0');
    } catch {
      // Ignore storage failures.
    }
  }

  public destroy(): void {
    this.stopTimers();
    this.detachDragHandlers();
    this.detachInteractionHandlers();
    window.removeEventListener('resize', this.onWindowResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.element.remove();
  }

  private attachInteractionHandlers(): void {
    this.element.addEventListener('mouseenter', this.onInteractionStart);
    this.element.addEventListener('mouseleave', this.onInteractionEnd);
  }

  private detachInteractionHandlers(): void {
    this.element.removeEventListener('mouseenter', this.onInteractionStart);
    this.element.removeEventListener('mouseleave', this.onInteractionEnd);
  }

  private onInteractionStart = (): void => {
    this.isPausedForInteraction = true;
    this.statusEl.textContent = 'Rotation paused while interacting';
  };

  private onInteractionEnd = (): void => {
    this.isPausedForInteraction = false;
    this.statusEl.textContent = 'Rotation resumed';
  };

  private onWindowResize = (): void => {
    const rect = this.element.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - this.element.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - this.element.offsetHeight);
    const clampedLeft = Math.min(Math.max(0, rect.left), maxLeft);
    const clampedTop = Math.min(Math.max(0, rect.top), maxTop);
    this.element.style.left = `${clampedLeft}px`;
    this.element.style.top = `${clampedTop}px`;
    this.element.style.bottom = 'auto';
    this.persistPosition();
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.stopTimers();
      return;
    }

    this.startTimers();
    void this.refreshHeadlines();
  };

  private attachDragHandlers(): void {
    this.dragHandleEl.addEventListener('mousedown', this.onDragStart);
    document.addEventListener('mousemove', this.onDragMove);
    document.addEventListener('mouseup', this.onDragEnd);
  }

  private detachDragHandlers(): void {
    this.dragHandleEl.removeEventListener('mousedown', this.onDragStart);
    document.removeEventListener('mousemove', this.onDragMove);
    document.removeEventListener('mouseup', this.onDragEnd);
  }

  private onDragStart = (event: MouseEvent): void => {
    event.preventDefault();
    const rect = this.element.getBoundingClientRect();
    this.isDragging = true;
    this.dragOffsetX = event.clientX - rect.left;
    this.dragOffsetY = event.clientY - rect.top;
    this.element.classList.add('obs-overlay--dragging');
  };

  private onDragMove = (event: MouseEvent): void => {
    if (!this.isDragging) return;
    const maxLeft = Math.max(0, window.innerWidth - this.element.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - this.element.offsetHeight);
    const left = Math.min(Math.max(0, event.clientX - this.dragOffsetX), maxLeft);
    const top = Math.min(Math.max(0, event.clientY - this.dragOffsetY), maxTop);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
    this.element.style.bottom = 'auto';
  };

  private onDragEnd = (): void => {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.element.classList.remove('obs-overlay--dragging');
    this.persistPosition();
  };

  private persistPosition(): void {
    const rect = this.element.getBoundingClientRect();
    const position: OverlayPosition = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
    };
    try {
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
    } catch {
      // Ignore storage failures.
    }
  }

  private restorePosition(): void {
    try {
      const raw = localStorage.getItem(POSITION_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as OverlayPosition;
      if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return;
      this.element.style.left = `${parsed.left}px`;
      this.element.style.top = `${parsed.top}px`;
      this.element.style.bottom = 'auto';
    } catch {
      // Ignore invalid cached positions.
    }
  }

  private restoreVisibility(): void {
    try {
      const fromQuery = new URL(location.href).searchParams.get('obs-overlay');
      if (fromQuery === '1') {
        this.toggleVisibility(true);
        return;
      }

      const stored = localStorage.getItem(VISIBLE_STORAGE_KEY);
      if (stored === '0') {
        this.toggleVisibility(false);
      }
    } catch {
      // Ignore.
    }
  }

  private restoreHeadlines(): void {
    try {
      const raw = localStorage.getItem(HEADLINES_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as OverlayHeadline[];
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      this.headlines = parsed.slice(0, 12);
      this.renderTicker();
      this.renderCarousel();
      this.statusEl.textContent = 'Showing cached headlines';
    } catch {
      // Ignore cache parsing issues.
    }
  }

  private startTimers(): void {
    this.stopTimers();
    this.refreshTimer = setInterval(() => {
      void this.refreshHeadlines();
    }, REFRESH_INTERVAL_MS);

    this.tickerTimer = setInterval(() => {
      if (this.headlines.length <= 1 || this.isPausedForInteraction) return;
      this.tickerIndex = (this.tickerIndex + 1) % this.headlines.length;
      this.renderTicker();
    }, this.tickerAdvanceMs);

    this.carouselTimer = setInterval(() => {
      if (this.headlines.length <= 1 || this.isPausedForInteraction) return;
      this.carouselIndex = (this.carouselIndex + 1) % this.headlines.length;
      this.renderCarousel();
    }, this.carouselAdvanceMs);
  }

  private stopTimers(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = null;
    }
    if (this.carouselTimer) {
      clearInterval(this.carouselTimer);
      this.carouselTimer = null;
    }
  }

  private async refreshHeadlines(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    this.statusEl.textContent = 'Updating…';
    const url = `/api/news/v1/list-feed-digest?variant=${encodeURIComponent(SITE_VARIANT)}&lang=${encodeURIComponent(getCurrentLanguage())}`;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json() as DigestResponse;
      const categories = Object.values(data.categories ?? {});
      const flattened = categories.flatMap((category) => category.items ?? []);

      const normalized = flattened
        .map((item) => {
          const title = (item.title ?? '').trim();
          const link = (item.link ?? '').trim();
          if (!title || !link) return null;
          const publishedAtMs = Date.parse(item.publishedAt ?? '') || Date.now();
          return {
            title,
            link,
            source: (item.source ?? 'Unknown').trim() || 'Unknown',
            publishedAtMs,
          } satisfies OverlayHeadline;
        })
        .filter((item): item is OverlayHeadline => item !== null)
        .sort((a, b) => b.publishedAtMs - a.publishedAtMs);

      const deduped = new Map<string, OverlayHeadline>();
      for (const item of normalized) {
        const key = `${item.link}|${item.title}`;
        if (!deduped.has(key)) deduped.set(key, item);
      }

      const topHeadlines = Array.from(deduped.values()).slice(0, 12);
      if (topHeadlines.length > 0) {
        this.headlines = topHeadlines;
        this.tickerIndex = 0;
        this.carouselIndex = 0;
        this.renderTicker();
        this.renderCarousel();
        this.statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        try {
          localStorage.setItem(HEADLINES_STORAGE_KEY, JSON.stringify(this.headlines));
        } catch {
          // Ignore cache write failures.
        }
        return;
      }

      this.statusEl.textContent = 'No headlines available';
    } catch (error) {
      console.warn('[ObsOverlay] Failed to refresh headlines:', error);
      this.statusEl.textContent = 'Using latest available headlines';
    } finally {
      this.isRefreshing = false;
    }
  }

  private renderTicker(): void {
    const headline = this.headlines[this.tickerIndex];
    if (!headline) {
      this.tickerTextEl.textContent = 'No headlines available';
      return;
    }

    const dateLabel = new Date(headline.publishedAtMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    this.tickerTextEl.textContent = `${headline.source} • ${dateLabel} • ${headline.title}`;
  }

  private renderCarousel(): void {
    const headline = this.headlines[this.carouselIndex];
    if (!headline) {
      this.carouselLinkEl.textContent = 'No headline selected';
      this.carouselLinkEl.removeAttribute('href');
      this.carouselMetaEl.textContent = '—';
      this.indexEl.textContent = '0/0';
      return;
    }

    this.carouselLinkEl.textContent = headline.title;
    this.carouselLinkEl.href = headline.link;
    this.carouselMetaEl.textContent = `${headline.source} • ${new Date(headline.publishedAtMs).toLocaleString()}`;
    this.indexEl.textContent = `${this.carouselIndex + 1}/${this.headlines.length}`;
  }
}