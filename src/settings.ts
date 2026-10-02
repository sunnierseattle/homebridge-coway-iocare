/** Platform name as it appears in the Homebridge config.json `platform` field. */
export const PLATFORM_NAME = 'CowayAirmega';

/** npm package name; must match package.json `name`. */
export const PLUGIN_NAME = 'homebridge-coway-iocare';

/** Coway IoCare endpoints. */
export const Endpoint = {
  OAUTH: 'https://id.coway.com/auth/realms/cw-account/protocol/openid-connect/auth',
  REDIRECT: 'https://iocare-redirect.iotsvc.coway.com/redirect_bridge_empty.html',
  BASE: 'https://iocare.iotsvc.coway.com/api/v1',
  WEBVIEW: 'https://iocare2.coway.com/en',
  /** The webview's own API proxy. The supplies (filter) endpoint lives here,
   *  not on the main API host. */
  PROXY: 'https://iocare2.coway.com/api/proxy/api/v1',
} as const;

export const CLIENT_ID = 'cwid-prd-iocare-plus-25MJGcYX';
export const CLIENT_NAME = 'IOCARE';
export const APP_VERSION = '2.15.0';
export const USER_AGENT = PLUGIN_NAME;

/** Coway marks purifiers with this Korean category name ("air purifier"). */
export const PURIFIER_CATEGORY = '청정기';

/**
 * Device control attribute codes used by the IoCare `control-status` endpoint.
 * These double as the keys of the status payload, so a write and a read of the
 * same concept share a code.
 */
export const Attr = {
  POWER: '0001',
  MODE: '0002',
  FAN_SPEED: '0003',
  LIGHT: '0007',
  TIMER: '0008',
  SENSITIVITY: '000A',
  LOCK: '0024',
} as const;

/** Values for the MODE attribute. */
export const Mode = {
  AUTO: '1',
  NIGHT: '2',
  RAPID: '5',
  ECO: '6',
} as const;

/** Access tokens are valid for one hour; refresh with this much margin left. */
export const TOKEN_TTL_MS = 60 * 60 * 1000;
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Default seconds between cloud polls. Each poll is several HTTPS round-trips. */
export const DEFAULT_POLL_INTERVAL_S = 60;
export const MIN_POLL_INTERVAL_S = 30;

/** Ceiling for the backoff between failed device discoveries at startup. */
export const MAX_DISCOVERY_RETRY_S = 15 * 60;
