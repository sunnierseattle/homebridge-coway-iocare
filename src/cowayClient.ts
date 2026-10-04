import {
  login as defaultLogin, refresh as defaultRefresh, type LoginOptions, type Tokens,
} from './cowayAuth.js';
import {
  CowayAuthError, CowayError, PasswordExpiredError, RateLimitedError, ServerMaintenanceError,
} from './errors.js';
import {
  extractStatusPayload, parsePurifierState, type FilterReading, type PurifierState,
} from './purifierState.js';
import {
  APP_VERSION,
  Endpoint,
  PURIFIER_CATEGORY,
  TOKEN_REFRESH_MARGIN_MS,
  USER_AGENT,
} from './settings.js';

export interface PurifierDevice {
  deviceSerial: string;
  nickname: string;
  placeId: string;
  /** Short internal code (e.g. "02EUZ"). The webview URL keys off this, not the
   *  marketing model number — using the wrong one yields a page with no data. */
  modelCode: string;
  /** Marketing model, e.g. "AP-2015E". Shown in HomeKit's accessory details. */
  productModel: string;
}

/** Coway's JSON responses are deeply nested and loosely typed; we validate the
 *  handful of fields we actually read rather than modelling the whole schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

interface ClientDeps {
  login: (u: string, p: string, options: LoginOptions) => Promise<Tokens>;
  refresh: (t: string) => Promise<Tokens>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Whether cached supplies still match the status page's filter readings. A
 * difference beyond rounding means the filter changed (a clean or a reset), so
 * the cache is stale. An unreported reading is no evidence either way.
 */
function agrees(readings: FilterReading[], statusPage: { pre?: number; max2?: number }): boolean {
  const pre = readings.find((f) => /pre-?filter/i.test(f.name))?.remainPct;
  const main = readings.find((f) => !/pre-?filter/i.test(f.name))?.remainPct;
  const close = (a?: number, b?: number) => a === undefined || b === undefined || Math.abs(a - b) <= 1;
  return close(pre, statusPage.pre) && close(main, statusPage.max2);
}

/** A hung connection would otherwise stall the poll loop indefinitely. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Retries after the first attempt, for server errors and dropped connections. */
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1_000;
/** Filter life moves by days, not minutes; no need to ask on every poll. */
const SUPPLIES_TTL_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Talks to Coway IoCare, holding one token pair across the plugin's lifetime. */
export class CowayClient {
  private tokens?: Tokens;
  /** In-flight auth, so concurrent accessors share one login instead of racing. */
  private pending?: Promise<string>;
  /**
   * Set once Coway rate-limits us or rejects the credentials. Either way another
   * login cannot succeed until the user acts, and every failed attempt counts
   * towards Coway's 24-hour lockout, so stop until Homebridge restarts.
   */
  private blocked?: Error;
  private readonly deps: ClientDeps;
  private readonly supplies = new Map<string, { at: number; readings: FilterReading[] }>();

  constructor(
    private readonly username: string,
    private readonly password: string,
    deps?: Partial<ClientDeps>,
    private readonly loginOptions: LoginOptions = {},
  ) {
    this.deps = { login: defaultLogin, refresh: defaultRefresh, sleep, ...deps };
  }

  /** Return a usable access token, logging in or refreshing only when needed. */
  async accessToken(): Promise<string> {
    if (this.blocked) {
      throw this.blocked;
    }

    const current = this.tokens;
    if (current && current.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return current.accessToken;
    }
    if (this.pending) {
      return this.pending;
    }

    this.pending = this.authenticate(current).finally(() => {
      this.pending = undefined; 
    });
    return this.pending;
  }

  private async authenticate(current: Tokens | undefined): Promise<string> {
    try {
      // A live refresh token is cheaper than a fresh login, and Coway counts
      // logins towards the threshold that triggers a 24-hour block.
      if (current) {
        try {
          this.tokens = await this.deps.refresh(current.refreshToken);
          return this.tokens.accessToken;
        } catch {
          this.tokens = undefined;
        }
      }
      this.tokens = await this.deps.login(this.username, this.password, this.loginOptions);
      return this.tokens.accessToken;
    } catch (err) {
      if (err instanceof RateLimitedError || err instanceof CowayAuthError
        || err instanceof PasswordExpiredError) {
        this.blocked = err;
      }
      throw err;
    }
  }

  private authHeaders(token: string): Record<string, string> {
    return {
      region: 'NUS',
      'content-type': 'application/json',
      accept: '*/*',
      authorization: `Bearer ${token}`,
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': USER_AGENT,
    };
  }

  /**
   * fetch with a timeout, retrying server errors and dropped connections with
   * exponential backoff. A 4xx is Coway's answer, not a fault, so it returns.
   */
  private async request(url: URL | string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (res.status < 500 || attempt >= MAX_RETRIES) {
          return res;
        }
      } catch (err) {
        if (attempt >= MAX_RETRIES) {
          throw err;
        }
      }
      await this.deps.sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }

  /**
   * A request carrying the access token. Coway can revoke a token before its
   * stated expiry; on a 401, refresh it and try once more rather than failing
   * every call until the local expiry passes.
   */
  private async authedRequest(
    url: URL | string, init: (token: string) => RequestInit,
  ): Promise<Response> {
    const res = await this.request(url, init(await this.accessToken()));
    if (res.status !== 401) {
      return res;
    }
    if (this.tokens) {
      this.tokens = { ...this.tokens, expiresAt: 0 };
    }
    return this.request(url, init(await this.accessToken()));
  }

  private async getJson(url: URL | string): Promise<Json> {
    const res = await this.authedRequest(url, (token) => ({ headers: this.authHeaders(token) }));
    const body = (await res.json()) as Json;
    if (body?.data && 'maintainInfos' in (body.data as object)) {
      throw new ServerMaintenanceError('Coway servers are undergoing maintenance.');
    }
    if (!res.ok) {
      throw new CowayError(`Coway returned ${res.status} for ${url}.`);
    }
    return body;
  }

  /** Every purifier across every "place" on the account. */
  async listPurifiers(): Promise<PurifierDevice[]> {
    const info = await this.getJson(`${Endpoint.BASE}/com/my-info`);
    const countryCode = (info.data as Json)?.memberInfo?.countryCode;

    const placesUrl = new URL(`${Endpoint.BASE}/com/places`);
    placesUrl.search = new URLSearchParams({
      countryCode: String(countryCode ?? 'US'),
      langCd: 'en',
      pageIndex: '1',
      pageSize: '20',
      timezoneId: 'UTC',
    }).toString();
    const places = ((await this.getJson(placesUrl)).data?.content ?? []) as Json[];

    const found: PurifierDevice[] = [];
    for (const place of places) {
      if (!place.deviceCnt) {
        continue;
      }
      const devicesUrl = new URL(`${Endpoint.BASE}/com/places/${place.placeId}/devices`);
      devicesUrl.search = new URLSearchParams({ pageIndex: '0', pageSize: '100' }).toString();
      const devices = ((await this.getJson(devicesUrl)).data?.content ?? []) as Json[];

      for (const d of devices) {
        if (d.categoryName !== PURIFIER_CATEGORY) {
          continue;
        }
        found.push({
          deviceSerial: String(d.deviceSerial),
          nickname: String(d.dvcNick),
          placeId: String(d.placeId),
          modelCode: String(d.modelCode),
          productModel: String(d.productModel),
        });
      }
    }
    return found;
  }

  /**
   * Read live state. Coway exposes no status JSON endpoint, so this fetches the
   * page the IoCare app renders in a webview and lifts the embedded payload.
   */
  async readState(device: PurifierDevice): Promise<PurifierState> {
    const url = new URL(`${Endpoint.WEBVIEW}/${device.placeId}/product/${device.modelCode}`);
    url.search = new URLSearchParams({
      bottomSlide: 'false', tab: '0', temperatureUnit: 'F', weightUnit: 'oz', gravityUnit: 'lb',
    }).toString();

    const res = await this.authedRequest(url, (token) => ({
      headers: {
        theme: 'light',
        callingpage: 'product',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        dvcnick: device.nickname,
        timezoneid: 'UTC',
        appversion: APP_VERSION,
        accesstoken: token,
        'accept-language': 'en-US,en;q=0.9',
        region: 'NUS',
        'user-agent': USER_AGENT,
        srcpath: 'iOS',
        deviceserial: device.deviceSerial,
      },
    }));
    if (!res.ok) {
      throw new CowayError(`Coway status page returned ${res.status}.`);
    }
    const payload = extractStatusPayload(await res.text());
    // The status page's own filter readings (percent used) are fresh every poll;
    // passing them lets a reset on the unit show without waiting out the cache.
    const used = (key: string) => (typeof payload.sensor[key] === 'number' ? 100 - payload.sensor[key] : undefined);
    const hint = { pre: used('0011'), max2: used('0012') };
    return parsePurifierState(payload, await this.fetchFilters(device, hint));
  }

  /**
   * Filter life from Coway's supplies endpoint. Not every model populates it --
   * the 250S's is still unfinished -- so a failure here is not fatal; the caller
   * falls back to the sensor attributes embedded in the status page.
   */
  async fetchFilters(
    device: PurifierDevice, statusPage: { pre?: number; max2?: number } = {},
  ): Promise<FilterReading[]> {
    const cached = this.supplies.get(device.deviceSerial);
    if (cached && Date.now() - cached.at < SUPPLIES_TTL_MS && agrees(cached.readings, statusPage)) {
      return cached.readings;
    }
    const url = new URL(
      `${Endpoint.PROXY}/com/places/${device.placeId}/devices/${device.deviceSerial}/supplies`,
    );
    url.search = new URLSearchParams({
      membershipYn: 'N', membershipType: '', langCd: 'en',
    }).toString();

    try {
      const body = await this.getJson(url);
      const list = (body.data?.suppliesList ?? []) as Json[];
      const readings = list
        .filter((f) => typeof f.filterRemain === 'number')
        .map((f) => ({
          name: String(f.supplyNm ?? ''),
          remainPct: Number(f.filterRemain),
        }));
      this.supplies.set(device.deviceSerial, { at: Date.now(), readings });
      return readings;
    } catch {
      return [];
    }
  }

  /** Send one control attribute. Coway accepts a single attribute per call. */
  async control(device: PurifierDevice, attribute: string, value: string): Promise<void> {
    const url = `${Endpoint.BASE}/com/places/${device.placeId}/devices/${device.deviceSerial}/control-status`;
    const res = await this.authedRequest(url, (token) => ({
      method: 'POST',
      headers: this.authHeaders(token),
      body: JSON.stringify({
        attributes: { [attribute]: value },
        isMultiControl: false,
        refreshFlag: false,
      }),
    }));

    const body = (await res.json().catch(() => ({}))) as { header?: { error_code?: string; error_text?: string } };
    const code = body.header?.error_code;
    if (!res.ok || code) {
      throw new CowayError(
        `Coway rejected ${attribute}=${value} for ${device.nickname}` +
          (code ? `: ${code} ${body.header?.error_text ?? ''}` : ` (HTTP ${res.status})`),
      );
    }
  }
}
