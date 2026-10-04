# Changelog

Each release is described here first; `npm version` and the release workflow refuse to release a version without its section. Releases before v1.3.0: see the [GitHub releases](https://github.com/sunnierseattle/homebridge-coway-iocare/releases).

## v1.4.0 — Sleep on the speed slider

### Sleep is now on the speed slider

The fan slider follows the Airmega panel's airflow ladder and has four steps:

| Slider | Purifier |
|---|---|
| 25% | **Sleep** |
| 50% | Low |
| 75% | Medium |
| 100% | High |

Previously Sleep showed as 33%, the same as Low, and could not be selected from the slider.

- **Your existing scenes keep working.** Scenes saved at 33% or 67% still set Low and Medium.
- Choosing **Manual** while the purifier is asleep keeps it in Sleep.
- With `exposeModeSwitches` on, turning the **Night Mode** switch off now steps up to Low instead of switching to Auto.

### Also in this release

- A pre-filter or Max2 reset on the unit now shows in Home within one poll, instead of up to 30 minutes later.

Verified end to end on an Airmega 400S in Homebridge 2.4.0.


## v1.3.1 — Package metadata for Homebridge verification

No change in behaviour. This release updates package metadata for the Homebridge verification checks:

- `package.json` declares the `supports-hap` keyword (HomeKit accessories).
- `config.schema.json` lists its required fields (name, username, password) in standard JSON Schema form.


## v1.3.0 — Reliability: sign-in, outages and offline handling

A reliability release: the plugin now rides out Coway outages, expired sessions and password prompts without needing a restart, and protects your account from Coway's login lockout.

### Account and sign-in

- **Coway's 60-day password-change prompt is deferred automatically,** the way the IoCare+ app's "change next time" does, and a reminder is logged. Set `skipPasswordChange` to `false` to have the plugin stop and report it instead.
- **No more retrying a rejected login.** After a wrong password or a password-change demand the plugin stops and logs why, rather than retrying every poll. Repeated failed logins trigger Coway's 24-hour lockout, which also locks the IoCare+ app.
- **Expired sessions recover by themselves:** if Coway rejects a token early, the plugin refreshes it and retries once.
- The config screen accepts a phone number as the sign-in ID.

### Staying connected

- **Startup retries:** if Coway is unreachable when Homebridge starts, discovery retries with a growing delay (up to 15 minutes) instead of leaving the purifier unresponsive until a restart.
- Requests time out after 15 seconds and retry server errors and dropped connections.
- **You'll see problems in the log:** a warning after 3 failed polls in a row (repeated every 30), and a note when Coway is reachable again. These were previously debug-only.
- **A purifier that's offline** (unplugged or off WiFi) shows **No Response** instead of its last known state.

### In the Home app

- **Fan speed 3 shows as 100%** (it showed 99%).
- **Filter change alerts start below 10%** life left, instead of only at 0%.
- **Extra tiles have their own names** ("Airmega 400S Pre-Filter", "… Air Quality", "… Light") instead of all reading as the purifier's name, and a name you change in Home is kept.
- The purifier's **firmware version** appears in its accessory details.
- **Dragging the speed slider** sends one command when you let go, not one per step, and the tile no longer flips back briefly after a change.

### Model support

- **Mode switches and the panel-light encoding come from the purifier itself,** using the list of settings it reports as supported, then Coway's product name, then the model code. New model codes work without a plugin update.
- The **250S and IconS panel light** is no longer inverted by default.
- **Mode switches** (`exposeModeSwitches`) only appear for modes your model supports.
- `lightConvention` defaults to **Automatic**. An explicit `onOff` or `mode` still wins.

Verified end to end on an Airmega 400S in Homebridge 2.4.0. The password-change deferral follows the same form submission as cowayaio and homebridge-airmega-iocare, but it hasn't been triggered on a live account yet.

