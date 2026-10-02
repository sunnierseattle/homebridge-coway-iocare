import { CowayAuthError, CowayError, PasswordExpiredError, RateLimitedError } from './errors.js';
import { CLIENT_ID, CLIENT_NAME, Endpoint, TOKEN_TTL_MS, USER_AGENT } from './settings.js';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which the access token stops being valid. */
  expiresAt: number;
}

/**
 * Minimal cookie store for the Keycloak login hop. Node's fetch has no cookie
 * jar, and the credential POST must echo back the session cookies set by the
 * login page or Keycloak rejects it as a stale form.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x3D;/g, '=');
}

/**
 * Pull a form's action URL out of raw HTML. Keycloak emits the id and action in
 * varying order, so we locate the tag by id first, then read its action.
 */
export function findFormAction(html: string, formId: string): string | null {
  const tags = html.match(/<form\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!new RegExp(`id=["']${formId}["']`, 'i').test(tag)) {
      continue;
    }
    const action = tag.match(/action=["']([^"']+)["']/i);
    if (action) {
      return decodeEntities(action[1]);
    }
  }
  return null;
}

/** Coway's 60-day policy interrupts the login with this page. */
function isPasswordChangePage(html: string): boolean {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  return title === 'Coway - Password change message';
}

function isHtml(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('text/html');
}

/**
 * Coway returns login failures as a rendered page, not an HTTP error, so the
 * body has to be inspected before we look for an auth code.
 */
export function detectLoginProblem(html: string): void {
  if (isPasswordChangePage(html)) {
    throw new PasswordExpiredError(
      'Coway is demanding a password change (its 60-day policy). Log in to the IoCare app, ' +
        'change the password, then update this plugin\'s configuration.',
    );
  }
  if (/Your ID or password is incorrect/i.test(html)) {
    throw new CowayAuthError('Coway rejected the username or password.');
  }
}

export interface LoginOptions {
  /**
   * Answer Coway's 60-day password-change page with "change next time", as the
   * IoCare app lets a person do. Otherwise the plugin stops working until the
   * password is changed.
   */
  skipPasswordChange?: boolean;
}

async function exchange(body: Record<string, string>, path: string): Promise<Tokens> {
  const res = await fetch(`${Endpoint.BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify(body),
  });

  const payload = (await res.json()) as {
    data?: { accessToken?: string; refreshToken?: string };
    error?: { message?: string };
  };

  const message = payload.error?.message;
  if (message?.includes('invalid_grant')) {
    // Coway blocks an account for ~24h after repeated failures. Retrying deepens it.
    throw new RateLimitedError(
      'Coway refused the token exchange (invalid_grant). The account is likely temporarily ' +
        'blocked; wait 24 hours and confirm the IoCare app still signs in.',
    );
  }

  const accessToken = payload.data?.accessToken;
  const refreshToken = payload.data?.refreshToken;
  if (!accessToken || !refreshToken) {
    throw new CowayError(`Coway returned no tokens${message ? `: ${message}` : '.'}`);
  }

  return { accessToken, refreshToken, expiresAt: Date.now() + TOKEN_TTL_MS };
}

/** Perform the full OAuth login and return a fresh token pair. */
export async function login(
  username: string, password: string, options: LoginOptions = {},
): Promise<Tokens> {
  const jar = new CookieJar();

  const authUrl = new URL(Endpoint.OAUTH);
  authUrl.search = new URLSearchParams({
    auth_type: '0',
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: Endpoint.REDIRECT,
    ui_locales: 'en',
  }).toString();

  const pageRes = await fetch(authUrl, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en',
    },
  });
  if (!pageRes.ok) {
    throw new CowayError(`Coway login page returned ${pageRes.status}.`);
  }
  jar.absorb(pageRes);

  const loginUrl = findFormAction(await pageRes.text(), 'kc-form-login');
  if (!loginUrl) {
    throw new CowayError('Coway did not return a login form.');
  }

  const submitRes = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
      cookie: jar.header(),
    },
    body: new URLSearchParams({
      clientName: CLIENT_NAME,
      termAgreementStatus: '',
      idp: '',
      username,
      password,
      rememberMe: 'on',
    }),
    redirect: 'follow',
  });

  let finalRes = submitRes;
  if (isHtml(submitRes)) {
    const html = await submitRes.clone().text();
    const skipUrl = options.skipPasswordChange && isPasswordChangePage(html)
      ? findFormAction(html, 'kc-password-change-form')
      : null;
    if (skipUrl) {
      jar.absorb(submitRes);
      // The same form the IoCare app submits for "change next time". The field
      // set matches cowayaio's and homebridge-airmega-iocare's.
      finalRes = await fetch(skipUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENT,
          cookie: jar.header(),
        },
        body: new URLSearchParams({
          cmd: 'change_next_time',
          checkPasswordNeededYn: 'Y',
          current_password: '',
          new_password: '',
          new_password_confirm: '',
        }),
        redirect: 'follow',
      });
    }
    // Checked again after a deferral, so a second demand fails rather than loops.
    if (isHtml(finalRes)) {
      detectLoginProblem(await finalRes.clone().text());
    }
  }

  const code = new URL(finalRes.url).searchParams.get('code');
  if (!code) {
    throw new CowayAuthError(
      'Coway completed the login form but returned no authorization code. ' +
        'Accounts that sign in with Google or Apple cannot be used by this plugin.',
    );
  }

  return exchange({ authCode: code, redirectUrl: Endpoint.REDIRECT }, '/com/token');
}

/** Trade a refresh token for a new pair. Coway rotates both. */
export async function refresh(refreshToken: string): Promise<Tokens> {
  return exchange({ refreshToken }, '/com/refresh-token');
}
