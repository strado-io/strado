import { describe, expect, it } from 'vitest';
import { browserTabLabel, previewKey } from './browserTabs';

describe('previewKey', () => {
  it('keeps the bare path for tab 1 and suffixes extras', () => {
    expect(previewKey('/wt/a', '1')).toBe('/wt/a');
    expect(previewKey('/wt/a', '2')).toBe('/wt/a\0browser:2');
  });
});

describe('browser tab meta persistence', () => {
  it('round-trips title+favicon per preview key so labels survive an app restart', async () => {
    const { readBrowserMeta, rememberBrowserMeta } = await import('./browserTabs');
    localStorage.removeItem('strado:browser-meta');
    rememberBrowserMeta('/wt/a', { title: 'Jobs Details', favicon: 'https://x/f.ico' });
    rememberBrowserMeta('/wt/a\0browser:2', { title: 'Google' });
    expect(readBrowserMeta()).toEqual({
      '/wt/a': { title: 'Jobs Details', favicon: 'https://x/f.ico' },
      '/wt/a\0browser:2': { title: 'Google' },
    });
    rememberBrowserMeta('/wt/a', { title: 'Changed' });
    expect(readBrowserMeta()['/wt/a']).toEqual({ title: 'Changed', favicon: 'https://x/f.ico' });
  });

  it('drops a key when remembering null', async () => {
    const { readBrowserMeta, rememberBrowserMeta } = await import('./browserTabs');
    localStorage.removeItem('strado:browser-meta');
    rememberBrowserMeta('/wt/a', { title: 'T' });
    rememberBrowserMeta('/wt/a', null);
    expect(readBrowserMeta()).toEqual({});
  });
});

describe('browser url persistence', () => {
  it('remembers urls per key and forgets a key on null (tab closed)', async () => {
    const { readBrowserUrls, rememberBrowserUrl } = await import('./browserTabs');
    localStorage.removeItem('strado:browser-urls');
    rememberBrowserUrl('/wt/a', 'http://localhost:3000');
    rememberBrowserUrl('/wt/a\0browser:2', 'http://localhost:5555/deep');
    expect(readBrowserUrls()).toEqual({
      '/wt/a': 'http://localhost:3000',
      '/wt/a\0browser:2': 'http://localhost:5555/deep',
    });
    rememberBrowserUrl('/wt/a\0browser:2', null);
    expect(readBrowserUrls()).toEqual({ '/wt/a': 'http://localhost:3000' });
  });

  it('removes the old generated port-3000 fallback once without blocking later user URLs', async () => {
    const { migrateGuessedBrowserUrls, readBrowserUrls, rememberBrowserUrl } = await import('./browserTabs');
    localStorage.removeItem('strado:browser-urls');
    localStorage.removeItem('strado:browser-clean-start-v1');
    rememberBrowserUrl('/wt/legacy', 'http://localhost:3000/');
    rememberBrowserUrl('/wt/custom', 'http://localhost:5555/app');

    expect(migrateGuessedBrowserUrls()).toEqual({ '/wt/custom': 'http://localhost:5555/app' });

    // The migration is one-shot: users can explicitly enter port 3000 later.
    rememberBrowserUrl('/wt/user', 'http://localhost:3000');
    expect(migrateGuessedBrowserUrls()).toEqual({
      '/wt/custom': 'http://localhost:5555/app',
      '/wt/user': 'http://localhost:3000',
    });
    expect(readBrowserUrls()).toHaveProperty('/wt/user');
  });
});

describe('browserTabLabel', () => {
  it('falls back to Browser / Browser N when the page has no title yet', () => {
    expect(browserTabLabel(undefined, '1')).toBe('Browser');
    expect(browserTabLabel('', '3')).toBe('Browser 3');
    expect(browserTabLabel('   ', '2')).toBe('Browser 2');
  });

  it('uses the page title, truncated with an ellipsis', () => {
    expect(browserTabLabel('Acme Dashboard', '1')).toBe('Acme Dashboard');
    expect(browserTabLabel('Jobs Details - Malgam Maahi CC - Mother Dairy', '2')).toBe(
      'Jobs Details - Malgam M…',
    );
  });
});
