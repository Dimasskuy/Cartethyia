import { decodeJwtPayload, record } from "../../authentication/oauth-flow-store";
import type { OAuthExchangeResult, OAuthImportInput, OAuthLoginField } from "../../authentication/oauth-flow-store";
import { OAuthClient } from "../../authentication/oauth-client";
import type { FetchLike } from "../../authentication/oauth-client";
import type { OAuthRefreshContext, OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import {
  AUTOCLAW_APP_ID,
  AUTOCLAW_CN_BASE_URL,
  fetchAutoClawUserApi,
} from "./autoclaw-shared";

const AUTOCLAW_REFRESH_PATH = "/userapi/v1/refresh";
const AUTOCLAW_WALLET_PATH = "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw";
const REFRESH_FALLBACK_MS = 24 * 60 * 60 * 1000;

interface AutoClawAccountMetadata {
  readonly deviceId: string;
  readonly userId?: string;
  readonly userName?: string;
}

interface AutoClawImportedCredential {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly metadata: AutoClawAccountMetadata;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function bearerValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("bearer ") ? trimmed.slice(7).trim() : trimmed;
}

function tokenExpiry(accessToken: string, body: Record<string, unknown>): Date {
  const explicitExpiry = body["expires_at"] ?? body["expiresAt"];
  if (typeof explicitExpiry === "number" && Number.isFinite(explicitExpiry)) {
    return new Date(explicitExpiry > 1_000_000_000_000 ? explicitExpiry : explicitExpiry * 1000);
  }
  if (typeof explicitExpiry === "string" && Number.isFinite(Date.parse(explicitExpiry))) {
    return new Date(explicitExpiry);
  }
  const expiresIn = body["expires_in"] ?? body["expiresIn"];
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000);
  }
  const exp = decodeJwtPayload(accessToken)?.["exp"];
  if (typeof exp === "number" && Number.isFinite(exp)) return new Date(exp * 1000);
  return new Date(Date.now() + REFRESH_FALLBACK_MS);
}

function importRecord(credential: string): Record<string, unknown> | undefined {
  const trimmed = credential.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("AutoClaw credential JSON is invalid");
  }
  const value = record(parsed);
  if (value === null) throw new Error("AutoClaw credential must be an object");
  return value;
}

function importedValue(
  fields: Readonly<Record<string, string>>,
  exported: Record<string, unknown> | undefined,
  fieldNames: readonly string[],
): string | undefined {
  for (const fieldName of fieldNames) {
    const fieldValue = fields[fieldName];
    if (typeof fieldValue === "string" && fieldValue.trim().length > 0) return fieldValue.trim();
  }
  for (const fieldName of fieldNames) {
    if (exported && Object.hasOwn(exported, fieldName)) {
      const value = nonEmptyString(exported[fieldName]);
      if (value === undefined) throw new Error(`AutoClaw credential ${fieldName} is blank`);
      return value;
    }
  }
  return undefined;
}

function accountMetadata(
  fields: Readonly<Record<string, string>>,
  exported: Record<string, unknown> | undefined,
): AutoClawAccountMetadata {
  const deviceId = importedValue(fields, exported, ["deviceId", "device_id"]);
  if (deviceId === undefined) throw new Error("AutoClaw device ID is required");
  const userId = importedValue(fields, exported, ["userId", "user_id"]);
  const userName = importedValue(fields, exported, ["userName", "user_name", "email"]);
  return {
    deviceId,
    ...(userId === undefined ? {} : { userId }),
    ...(userName === undefined ? {} : { userName }),
  };
}

function importFieldsWithDefaults(input: OAuthImportInput): AutoClawImportedCredential {
  const credential = input.credential.trim();
  if (credential.length === 0) throw new Error("AutoClaw access token is required");
  const exported = importRecord(credential);
  const accessToken = importedValue(input.fields, exported, ["accessToken", "access_token"])
    ?? (exported === undefined ? credential : undefined);
  if (accessToken === undefined) throw new Error("AutoClaw access token is required");
  const refreshToken = importedValue(input.fields, exported, ["refreshToken", "refresh_token"]);
  if (refreshToken === undefined) throw new Error("AutoClaw refresh token is required");
  const region = importedValue(input.fields, exported, ["region"]);
  if (region !== undefined && region.toLowerCase() !== "cn") {
    throw new Error("AutoClaw accounts in this server-side channel must use the CN region");
  }
  return {
    accessToken: bearerValue(accessToken),
    refreshToken: bearerValue(refreshToken),
    metadata: accountMetadata(input.fields, exported),
  };
}

/** Import-only AutoClaw OAuth client with the provider's current refresh implementation. */
export class AutoClawOAuthClient extends OAuthClient {
  protected readonly providerLabel = "AutoClaw";
  protected readonly clientId = AUTOCLAW_APP_ID;
  protected readonly tokenUrl = `${AUTOCLAW_CN_BASE_URL}${AUTOCLAW_REFRESH_PATH}`;
  protected readonly scopes = "";
  readonly supportsDeviceCode = false;
  readonly supportsBrowserCode = false;
  readonly requiresAccessToken = true;
  readonly importFields: readonly OAuthLoginField[] = [
    { key: "refreshToken", label: "Refresh token", required: true, secret: true },
    { key: "deviceId", label: "Device ID", required: true, placeholder: "From the AutoClaw account" },
    { key: "userId", label: "AutoClaw user ID" },
    { key: "userName", label: "Account name or email" },
    {
      key: "region",
      label: "Region",
      defaultValue: "cn",
      options: [{ value: "cn", label: "China (CN)" }],
    },
  ];

  constructor(fetchFn?: FetchLike) {
    super(fetchFn);
  }

  async importCredential(input: OAuthImportInput): Promise<OAuthExchangeResult> {
    const { accessToken, refreshToken, metadata } = importFieldsWithDefaults(input);
    const authState = {
      region: "cn",
      deviceId: metadata.deviceId,
      ...(metadata.userId === undefined ? {} : { userId: metadata.userId }),
      ...(metadata.userName === undefined ? {} : { userName: metadata.userName }),
    };
    const refreshed = await this.refresh(refreshToken, undefined, {
      account_id: "autoclaw-import",
      auth_state: authState,
      access_token: accessToken,
    });
    const wallet = record(await fetchAutoClawUserApi(AUTOCLAW_WALLET_PATH, refreshed.access, {
      fetcher: this.fetchFn,
    }));
    const balanceValue = wallet?.["total_balance"];
    const balance = typeof balanceValue === "number"
      ? balanceValue
      : typeof balanceValue === "string" && balanceValue.trim().length > 0
        ? Number(balanceValue)
        : NaN;
    if (!Number.isFinite(balance) || balance < 0) {
      throw new Error("AutoClaw wallet response did not contain a valid total balance");
    }
    return {
      access: refreshed.access,
      refresh: refreshed.refresh ?? refreshToken,
      expiresAt: refreshed.expiresAt,
      accountLabel: metadata.userName ?? metadata.userId ?? "AutoClaw account",
      auth_state: authState,
    };
  }

  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
    context?: OAuthRefreshContext,
  ): Promise<OAuthTokenRefreshResult> {
    const accessToken = nonEmptyString(context?.access_token);
    const authState = record(context?.auth_state);
    const deviceId = nonEmptyString(authState?.["deviceId"]) ?? nonEmptyString(authState?.["device_id"]);
    if (!accessToken) throw new Error("AutoClaw refresh requires the current access token");
    if (!deviceId) throw new Error("AutoClaw refresh requires the account device ID");
    const data = record(await fetchAutoClawUserApi(AUTOCLAW_REFRESH_PATH, accessToken, {
      method: "POST",
      body: {
        source_id: "autoclaw",
        device_id: deviceId,
        refresh_token: bearerValue(refreshToken),
      },
      ...(signal === undefined ? {} : { signal }),
      fetcher: this.fetchFn,
    }));
    if (!data) throw new Error("AutoClaw refresh response data is invalid");
    const access = nonEmptyString(data["access_token"]);
    if (!access) throw new Error("AutoClaw refresh response did not contain an access token");
    const rotatedRefresh = nonEmptyString(data["refresh_token"]);
    return {
      access: bearerValue(access),
      ...(rotatedRefresh === undefined ? {} : { refresh: bearerValue(rotatedRefresh) }),
      expiresAt: tokenExpiry(access, data),
    };
  }
}

/** Import-only AutoClaw credential client with the provider's refresh implementation. */
export const autoclawOAuthClient = new AutoClawOAuthClient();
