import * as flatbuffers from 'flatbuffers';
import {
  AuthorizationRequest as FbAuthorizationRequest,
} from '../generated/privchat/protocol/authorization-request.js';
import {
  AuthorizationResponse as FbAuthorizationResponse,
} from '../generated/privchat/protocol/authorization-response.js';
import {
  AuthType as FbAuthType,
} from '../generated/privchat/protocol/auth-type.js';
import {
  ClientInfo as FbClientInfo,
} from '../generated/privchat/protocol/client-info.js';
import {
  DeviceInfo as FbDeviceInfo,
} from '../generated/privchat/protocol/device-info.js';
import {
  DeviceType as FbDeviceType,
} from '../generated/privchat/protocol/device-type.js';
import {
  Property as FbProperty,
} from '../generated/privchat/protocol/property.js';
import {
  ServerInfo as FbServerInfo,
} from '../generated/privchat/protocol/server-info.js';
import {
  bigintToOptionalIdString,
  bigintToNumber,
  numberToBigint,
  optionalIdStringToBigint,
} from './ids.js';

// ----- Public enums (string unions, mirror the fbs enum names) -----

export type AuthType =
  | 'unspecified'
  | 'jwt'
  | 'user_password'
  | 'oauth'
  | 'anonymous';

export type DeviceType =
  | 'unknown'
  | 'ios'
  | 'android'
  | 'web'
  | 'macos'
  | 'windows'
  | 'linux'
  | 'iot';

const AUTH_TYPE_TO_FB: Record<AuthType, FbAuthType> = {
  unspecified: FbAuthType.Unspecified,
  jwt: FbAuthType.JWT,
  user_password: FbAuthType.UserPassword,
  oauth: FbAuthType.OAuth,
  anonymous: FbAuthType.Anonymous,
};
const AUTH_TYPE_FROM_FB: Record<number, AuthType> = {
  [FbAuthType.Unspecified]: 'unspecified',
  [FbAuthType.JWT]: 'jwt',
  [FbAuthType.UserPassword]: 'user_password',
  [FbAuthType.OAuth]: 'oauth',
  [FbAuthType.Anonymous]: 'anonymous',
};

const DEVICE_TYPE_TO_FB: Record<DeviceType, FbDeviceType> = {
  unknown: FbDeviceType.Unknown,
  ios: FbDeviceType.iOS,
  android: FbDeviceType.Android,
  web: FbDeviceType.Web,
  macos: FbDeviceType.MacOS,
  windows: FbDeviceType.Windows,
  linux: FbDeviceType.Linux,
  iot: FbDeviceType.IoT,
};
const DEVICE_TYPE_FROM_FB: Record<number, DeviceType> = {
  [FbDeviceType.Unknown]: 'unknown',
  [FbDeviceType.iOS]: 'ios',
  [FbDeviceType.Android]: 'android',
  [FbDeviceType.Web]: 'web',
  [FbDeviceType.MacOS]: 'macos',
  [FbDeviceType.Windows]: 'windows',
  [FbDeviceType.Linux]: 'linux',
  [FbDeviceType.IoT]: 'iot',
};

// ----- Public types -----

export interface ClientInfo {
  client_type: string;
  version: string;
  os: string;
  os_version: string;
  device_model?: string;
  app_package?: string;
}

export interface DeviceInfo {
  device_id: string;
  device_type: DeviceType;
  app_id: string;
  push_token?: string;
  push_channel?: string;
  device_name: string;
  device_model?: string;
  os_version?: string;
  app_version?: string;
  manufacturer?: string;
  device_fingerprint?: string;
}

export interface ServerInfo {
  version: string;
  name: string;
  features: string[];
  max_message_size: number;
  connection_timeout: number;
}

export interface AuthorizationRequest {
  auth_type: AuthType;
  auth_token: string;
  client_info: ClientInfo;
  device_info: DeviceInfo;
  protocol_version: string;
  /** Application-defined string→string map. */
  properties: Record<string, string>;
}

export interface AuthorizationResponse {
  success: boolean;
  error_code?: number;
  error_message?: string;
  session_id?: string;
  user_id?: string;
  connection_id?: string;
  server_info?: ServerInfo;
  /** Heartbeat interval in seconds. */
  heartbeat_interval?: number;
}

// ----- Internal helpers -----

function optStringOffset(builder: flatbuffers.Builder, s: string | undefined): flatbuffers.Offset {
  return s !== undefined ? builder.createString(s) : 0;
}

function buildClientInfo(builder: flatbuffers.Builder, info: ClientInfo): flatbuffers.Offset {
  const ct = builder.createString(info.client_type);
  const v = builder.createString(info.version);
  const os = builder.createString(info.os);
  const osv = builder.createString(info.os_version);
  const dm = optStringOffset(builder, info.device_model);
  const ap = optStringOffset(builder, info.app_package);
  return FbClientInfo.createClientInfo(builder, ct, v, os, osv, dm, ap);
}

function readClientInfo(view: FbClientInfo | null): ClientInfo {
  if (!view) {
    return { client_type: '', version: '', os: '', os_version: '' };
  }
  return {
    client_type: view.clientType() ?? '',
    version: view.version() ?? '',
    os: view.os() ?? '',
    os_version: view.osVersion() ?? '',
    device_model: view.deviceModel() ?? undefined,
    app_package: view.appPackage() ?? undefined,
  };
}

function buildDeviceInfo(builder: flatbuffers.Builder, info: DeviceInfo): flatbuffers.Offset {
  const did = builder.createString(info.device_id);
  const aid = builder.createString(info.app_id);
  const pt = optStringOffset(builder, info.push_token);
  const pc = optStringOffset(builder, info.push_channel);
  const dn = builder.createString(info.device_name);
  const dm = optStringOffset(builder, info.device_model);
  const osv = optStringOffset(builder, info.os_version);
  const av = optStringOffset(builder, info.app_version);
  const mf = optStringOffset(builder, info.manufacturer);
  const fp = optStringOffset(builder, info.device_fingerprint);
  return FbDeviceInfo.createDeviceInfo(
    builder,
    did,
    DEVICE_TYPE_TO_FB[info.device_type],
    aid,
    pt,
    pc,
    dn,
    dm,
    osv,
    av,
    mf,
    fp,
  );
}

function readDeviceInfo(view: FbDeviceInfo | null): DeviceInfo {
  if (!view) {
    return {
      device_id: '',
      device_type: 'unknown',
      app_id: '',
      device_name: '',
    };
  }
  return {
    device_id: view.deviceId() ?? '',
    device_type: DEVICE_TYPE_FROM_FB[view.deviceType()] ?? 'unknown',
    app_id: view.appId() ?? '',
    push_token: view.pushToken() ?? undefined,
    push_channel: view.pushChannel() ?? undefined,
    device_name: view.deviceName() ?? '',
    device_model: view.deviceModel() ?? undefined,
    os_version: view.osVersion() ?? undefined,
    app_version: view.appVersion() ?? undefined,
    manufacturer: view.manufacturer() ?? undefined,
    device_fingerprint: view.deviceFingerprint() ?? undefined,
  };
}

function buildServerInfo(builder: flatbuffers.Builder, info: ServerInfo): flatbuffers.Offset {
  const v = builder.createString(info.version);
  const n = builder.createString(info.name);
  const featureOffsets = info.features.map((f) => builder.createString(f));
  const features = FbServerInfo.createFeaturesVector(builder, featureOffsets);
  return FbServerInfo.createServerInfo(
    builder,
    v,
    n,
    features,
    numberToBigint(info.max_message_size),
    numberToBigint(info.connection_timeout),
  );
}

function readServerInfo(view: FbServerInfo | null): ServerInfo | undefined {
  if (!view) return undefined;
  const features: string[] = [];
  for (let i = 0; i < view.featuresLength(); i++) {
    const f = view.features(i);
    if (f !== null) features.push(f);
  }
  return {
    version: view.version() ?? '',
    name: view.name() ?? '',
    features,
    max_message_size: bigintToNumber(view.maxMessageSize()),
    connection_timeout: bigintToNumber(view.connectionTimeout()),
  };
}

// ----- Public encode / decode -----

export function encodeAuthorizationRequest(msg: AuthorizationRequest): Uint8Array {
  const builder = new flatbuffers.Builder(1024);
  const tokenOff = builder.createString(msg.auth_token);
  const ciOff = buildClientInfo(builder, msg.client_info);
  const diOff = buildDeviceInfo(builder, msg.device_info);
  const pvOff = builder.createString(msg.protocol_version);

  const propOffsets = Object.entries(msg.properties).map(([k, v]) =>
    FbProperty.createProperty(builder, builder.createString(k), builder.createString(v)),
  );
  const propVec = FbAuthorizationRequest.createPropertiesVector(builder, propOffsets);

  FbAuthorizationRequest.startAuthorizationRequest(builder);
  FbAuthorizationRequest.addAuthType(builder, AUTH_TYPE_TO_FB[msg.auth_type]);
  FbAuthorizationRequest.addAuthToken(builder, tokenOff);
  FbAuthorizationRequest.addClientInfo(builder, ciOff);
  FbAuthorizationRequest.addDeviceInfo(builder, diOff);
  FbAuthorizationRequest.addProtocolVersion(builder, pvOff);
  FbAuthorizationRequest.addProperties(builder, propVec);
  const offset = FbAuthorizationRequest.endAuthorizationRequest(builder);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodeAuthorizationRequest(bytes: Uint8Array): AuthorizationRequest {
  const view = FbAuthorizationRequest.getRootAsAuthorizationRequest(
    new flatbuffers.ByteBuffer(bytes),
  );
  const properties: Record<string, string> = {};
  for (let i = 0; i < view.propertiesLength(); i++) {
    const p = view.properties(i);
    if (p) properties[p.key() ?? ''] = p.value() ?? '';
  }
  return {
    auth_type: AUTH_TYPE_FROM_FB[view.authType()] ?? 'unspecified',
    auth_token: view.authToken() ?? '',
    client_info: readClientInfo(view.clientInfo()),
    device_info: readDeviceInfo(view.deviceInfo()),
    protocol_version: view.protocolVersion() ?? '',
    properties,
  };
}

export function encodeAuthorizationResponse(msg: AuthorizationResponse): Uint8Array {
  const builder = new flatbuffers.Builder(512);
  const errMsgOff = optStringOffset(builder, msg.error_message);
  const sessionOff = optStringOffset(builder, msg.session_id);
  const connOff = optStringOffset(builder, msg.connection_id);
  const serverOff = msg.server_info ? buildServerInfo(builder, msg.server_info) : 0;

  FbAuthorizationResponse.startAuthorizationResponse(builder);
  FbAuthorizationResponse.addSuccess(builder, msg.success);
  FbAuthorizationResponse.addErrorCode(builder, msg.error_code ?? 0);
  if (errMsgOff) FbAuthorizationResponse.addErrorMessage(builder, errMsgOff);
  if (sessionOff) FbAuthorizationResponse.addSessionId(builder, sessionOff);
  FbAuthorizationResponse.addUserId(builder, optionalIdStringToBigint(msg.user_id));
  if (connOff) FbAuthorizationResponse.addConnectionId(builder, connOff);
  if (serverOff) FbAuthorizationResponse.addServerInfo(builder, serverOff);
  FbAuthorizationResponse.addHeartbeatInterval(
    builder,
    msg.heartbeat_interval !== undefined
      ? numberToBigint(msg.heartbeat_interval)
      : 0n,
  );
  const offset = FbAuthorizationResponse.endAuthorizationResponse(builder);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodeAuthorizationResponse(bytes: Uint8Array): AuthorizationResponse {
  const view = FbAuthorizationResponse.getRootAsAuthorizationResponse(
    new flatbuffers.ByteBuffer(bytes),
  );
  const errCode = view.errorCode();
  const heartbeatBig = view.heartbeatInterval();
  return {
    success: view.success(),
    error_code: errCode === 0 ? undefined : errCode,
    error_message: view.errorMessage() ?? undefined,
    session_id: view.sessionId() ?? undefined,
    user_id: bigintToOptionalIdString(view.userId()),
    connection_id: view.connectionId() ?? undefined,
    server_info: readServerInfo(view.serverInfo()),
    heartbeat_interval: heartbeatBig === 0n ? undefined : bigintToNumber(heartbeatBig),
  };
}
