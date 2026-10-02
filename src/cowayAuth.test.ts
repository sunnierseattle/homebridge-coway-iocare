import { afterEach, describe, expect, it, vi } from 'vitest';

import { CookieJar, findFormAction, decodeEntities, detectLoginProblem, login } from './cowayAuth.js';
import { CowayAuthError, PasswordExpiredError } from './errors.js';

describe('CookieJar', () => {
  const res = (cookies: string[]) =>
    ({ headers: { getSetCookie: () => cookies } }) as unknown as Response;

  it('collects cookies and renders them as a request header', () => {
    const jar = new CookieJar();
    jar.absorb(res(['AUTH_SESSION_ID=abc; Path=/; HttpOnly', 'KC_RESTART=xyz; Path=/']));
    expect(jar.header()).toBe('AUTH_SESSION_ID=abc; KC_RESTART=xyz');
  });

  it('lets a later value replace an earlier one for the same name', () => {
    const jar = new CookieJar();
    jar.absorb(res(['a=1']));
    jar.absorb(res(['a=2']));
    expect(jar.header()).toBe('a=2');
  });

  it('keeps values that themselves contain "=" intact', () => {
    const jar = new CookieJar();
    jar.absorb(res(['token=abc=def==; Path=/']));
    expect(jar.header()).toBe('token=abc=def==');
  });

  it('is empty, not broken, when a response sets no cookies', () => {
    const jar = new CookieJar();
    jar.absorb({ headers: {} } as unknown as Response);
    expect(jar.header()).toBe('');
  });
});

describe('decodeEntities', () => {
  it('unescapes the entities Keycloak puts in form action URLs', () => {
    expect(decodeEntities('a?x=1&amp;y=2&#x3D;3')).toBe('a?x=1&y=2=3');
  });
});

describe('findFormAction', () => {
  it('finds the action regardless of attribute order', () => {
    const html = '<form method="post" id="kc-form-login" action="https://x/y?a=1&amp;b=2">';
    expect(findFormAction(html, 'kc-form-login')).toBe('https://x/y?a=1&b=2');
  });

  it('picks the right form when the page has several', () => {
    const html = '<form id="other" action="/nope"></form><form action="/yes" id="kc-form-login"></form>';
    expect(findFormAction(html, 'kc-form-login')).toBe('/yes');
  });

  it('returns null when the form is absent', () => {
    expect(findFormAction('<html></html>', 'kc-form-login')).toBeNull();
  });
});

describe('detectLoginProblem', () => {
  it('flags bad credentials', () => {
    const html = '<title>Login</title><p class="member_error_msg">Your ID or password is incorrect.</p>';
    expect(() => detectLoginProblem(html)).toThrow(CowayAuthError);
  });

  it('flags the 60-day forced password change, which a headless login cannot clear', () => {
    const html = '<title>Coway - Password change message</title>';
    expect(() => detectLoginProblem(html)).toThrow(PasswordExpiredError);
  });

  it('passes a normal page through', () => {
    expect(() => detectLoginProblem('<title>IoCare</title>')).not.toThrow();
  });
});

describe('login', () => {
  const html = (body: string) => ({
    ok: true, status: 200, url: 'https://id.coway.com/page',
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => body,
    clone() {
      return this;
    },
  });
  const loginPage = html(
    '<form id="kc-form-login" action="https://id.coway.com/login-actions/authenticate?x=1&amp;y=2">');
  const passwordChangePage = html('<title>Coway - Password change message</title>' +
    '<form id="kc-password-change-form" action="https://id.coway.com/login-actions/required-action?s=9">');
  const redirectWithCode = {
    ...html(''), url: 'https://iocare-redirect.iotsvc.coway.com/redirect_bridge_empty.html?code=CODE',
    headers: new Headers({ 'content-type': 'text/plain' }),
  };
  const tokenResponse = { json: async () => ({ data: { accessToken: 'a', refreshToken: 'r' } }) };

  afterEach(() => vi.unstubAllGlobals());

  it('defers Coway\'s 60-day password change when allowed to, and finishes signing in', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(loginPage)
      .mockResolvedValueOnce(passwordChangePage)
      .mockResolvedValueOnce(redirectWithCode)
      .mockResolvedValueOnce(tokenResponse);
    vi.stubGlobal('fetch', fetch);

    await expect(login('u', 'p', { skipPasswordChange: true })).resolves.toMatchObject({ accessToken: 'a' });

    const [url, init] = fetch.mock.calls[2];
    expect(url).toBe('https://id.coway.com/login-actions/required-action?s=9');
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      cmd: 'change_next_time', checkPasswordNeededYn: 'Y',
      current_password: '', new_password: '', new_password_confirm: '',
    });
  });

  it('reports the forced password change when not allowed to defer it', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(loginPage)
      .mockResolvedValueOnce(passwordChangePage));
    await expect(login('u', 'p', { skipPasswordChange: false })).rejects.toThrow(PasswordExpiredError);
  });

  it('does not loop if Coway asks again after the deferral', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(loginPage)
      .mockResolvedValueOnce(passwordChangePage)
      .mockResolvedValueOnce(passwordChangePage));
    await expect(login('u', 'p', { skipPasswordChange: true })).rejects.toThrow(PasswordExpiredError);
  });
});
