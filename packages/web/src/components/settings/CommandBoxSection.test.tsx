import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mc = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
const rc = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
const profile = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
const vc = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock('../../api', () => ({ api: { modelCredential: mc, routerCredential: rc, voiceCredential: vc, profile } }));

import { CommandBoxSection } from './CommandBoxSection';

beforeEach(() => {
  localStorage.clear();
  mc.get.mockReset().mockResolvedValue({ present: false, last4: null });
  mc.save.mockReset();
  rc.get.mockReset().mockResolvedValue({ present: false, last4: null });
  rc.save.mockReset();
  vc.get.mockReset().mockResolvedValue({ present: false, last4: null });
  vc.save.mockReset();
  profile.get.mockReset().mockResolvedValue({ fullName: '', callMe: '', telemetryOptOut: false, jarvisLocalOnly: false });
  profile.save.mockReset().mockImplementation(async (p: object) => ({ fullName: '', callMe: '', telemetryOptOut: false, ...p }));
});

// A fake key, built from pieces so secret scanners don't read it as a leak.
const FAKE_KEY = `${'sk-' + 'ant-'}api03-secretWXYZ`;

describe('CommandBoxSection', () => {
  it('saves an Anthropic key and then shows only its last four', async () => {
    mc.save.mockResolvedValue({ present: true, last4: 'WXYZ' });
    render(<CommandBoxSection />);
    const input = await screen.findByLabelText(/anthropic api key/i);
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: FAKE_KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Anthropic key' }));
    await waitFor(() => expect(mc.save).toHaveBeenCalledWith(FAKE_KEY));
    expect(await screen.findByText(/••••WXYZ/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(FAKE_KEY)).not.toBeInTheDocument();
  });

  it('removes a saved key; says the key is shared with runners', async () => {
    mc.get.mockResolvedValue({ present: true, last4: '1234' });
    mc.save.mockResolvedValue({ present: false, last4: null });
    render(<CommandBoxSection />);
    expect(await screen.findByText(/••••1234/)).toBeInTheDocument();
    expect(screen.getByText(/also used by your runners/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Anthropic key' }));
    await waitFor(() => expect(mc.save).toHaveBeenCalledWith(null));
    expect(await screen.findByLabelText(/anthropic api key/i)).toBeInTheDocument();
  });

  it('an optional OpenRouter key for Jev (instant navigation); saved and removed like the Anthropic one', async () => {
    rc.save.mockResolvedValueOnce({ present: true, last4: 'R0UT' }).mockResolvedValueOnce({ present: false, last4: null });
    render(<CommandBoxSection />);
    const input = await screen.findByLabelText('OpenRouter key (fast decisions, Jev)');
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByText('Optional. Instant navigation commands; everything else still uses Haiku.')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'sk-or-v1-secretR0UT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save OpenRouter key' }));
    await waitFor(() => expect(rc.save).toHaveBeenCalledWith('sk-or-v1-secretR0UT'));
    expect(await screen.findByText(/••••R0UT/)).toBeInTheDocument();
    expect(mc.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenRouter key' }));
    await waitFor(() => expect(rc.save).toHaveBeenLastCalledWith(null));
    expect(await screen.findByLabelText('OpenRouter key (fast decisions, Jev)')).toBeInTheDocument();
  });

  it('the Local only toggle lives in the profile (the server enforces it), off by default', async () => {
    render(<CommandBoxSection />);
    const box = await screen.findByRole('checkbox', { name: /local only/i });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(profile.save).toHaveBeenCalledWith({ jarvisLocalOnly: true }));
    expect(box).toBeChecked();
  });
  it('a failed Local only save flips back and says why', async () => {
    profile.save.mockRejectedValue(new Error('offline'));
    render(<CommandBoxSection />);
    const box = await screen.findByRole('checkbox', { name: /local only/i });
    fireEvent.click(box);
    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(box).not.toBeChecked();
  });

  it('a failed save shows the error and keeps the field', async () => {
    mc.save.mockRejectedValue(new Error('key looks wrong'));
    render(<CommandBoxSection />);
    fireEvent.change(await screen.findByLabelText(/anthropic api key/i), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Anthropic key' }));
    expect(await screen.findByText('key looks wrong')).toBeInTheDocument();
    expect(screen.getByLabelText(/anthropic api key/i)).toBeInTheDocument();
  });

  it('has no wake-word toggle, even in the desktop app (voice is hold-to-talk only)', async () => {
    (window as { strado?: unknown }).strado = { voice: { available: true, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), onEvent: () => () => {} } };
    try {
      render(<CommandBoxSection />);
      await screen.findByRole('checkbox', { name: /local only/i });
      expect(screen.queryByText(/Hey Strado/)).not.toBeInTheDocument();
      expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    } finally {
      delete (window as { strado?: unknown }).strado;
    }
  });

  it('the ElevenLabs key (voice): saved through its own credential, only the last four shown; the voice engine is told to re-check', async () => {
    vc.save.mockResolvedValue({ present: true, last4: 'k9Z2' });
    const changed = vi.fn();
    window.addEventListener('strado:voice-engine', changed);
    render(<CommandBoxSection />);
    const input = await screen.findByLabelText('ElevenLabs API key (voice)');
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByText(/uses ElevenLabs Scribe v2 Realtime \(audio goes to ElevenLabs\)\. Without a key, Strado uses on-device Apple speech\./)).toBeInTheDocument();
    expect(screen.getByText(/Local only keeps voice on this Mac/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'sk_abc123k9Z2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save ElevenLabs key' }));
    await waitFor(() => expect(vc.save).toHaveBeenCalledWith('sk_abc123k9Z2'));
    expect(await screen.findByText(/••••k9Z2/)).toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
    window.removeEventListener('strado:voice-engine', changed);
  });

  it('turning Local only on or off tells the voice engine to re-check too', async () => {
    const changed = vi.fn();
    window.addEventListener('strado:voice-engine', changed);
    profile.save.mockResolvedValue({ jarvisLocalOnly: true });
    render(<CommandBoxSection />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /local only/i }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    window.removeEventListener('strado:voice-engine', changed);
  });
});
