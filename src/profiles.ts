import * as vscode from 'vscode';
import { FtpConfig, normalizeLocalPath } from './config';
import { Logger } from './logger';

export interface ProfileSettings {
  protocol?: 'ftp' | 'ftps' | 'sftp';
  host: string;
  port?: number;
  user: string;
  /** Password in chiaro — preferire Secret Storage. Lasciare vuoto se si usa keychain. */
  password?: string;
  remotePath: string;
  localRoot?: string;
  uploadOnSave?: boolean;
  ignore?: string[];
  passive?: boolean;
  timeout?: number;
  showNotifications?: boolean;
  ftpsImplicit?: boolean;
  rejectUnauthorized?: boolean;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface ProfileMap {
  [name: string]: ProfileSettings;
}

/**
 * Legge tutti i profili da ftpDeploy.profiles nel settings.json.
 * Se non ci sono profili, crea un profilo "default" dalle impostazioni flat legacy.
 */
const FALLBACK_READ_TIMEOUT_MS = 3000;

/**
 * Legge un file con un timeout, cosi uno share di rete irraggiungibile non
 * blocca il fallback all'infinito (fs.readFileSync bloccherebbe l'extension host).
 */
function readFileWithTimeout(filePath: string, timeoutMs: number): Promise<string> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<string>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms reading ${filePath}`)), timeoutMs);
  });
  return Promise.race([
    require('fs/promises').readFile(filePath, 'utf8'),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/**
 * Rimuove commenti // e /* *\/ da un JSONC, tracciando se ci si trova dentro
 * una stringa JSON (con gestione dell'escape \") per non corrompere valori
 * come "**\/.vscode/**" che contengono la sequenza // senza essere un commento.
 */
function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      result += ch;
      if (ch === '\\') {
        // copia anche il carattere escapato cosi non si esce dalla stringa su \"
        result += next ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }
  return result;
}

export async function loadProfiles(logger?: Logger): Promise<ProfileMap> {
  // Prima prova via API VS Code
  const cfg = vscode.workspace.getConfiguration('ftpDeploy');
  const profiles = cfg.get<ProfileMap>('profiles');

  // Non basta che esistano chiavi: su drive di rete la cache di getConfiguration()
  // può restare stale (watcher non affidabile su UNC/mapped drive) e restituire
  // un profilo con valori vuoti/vecchi. Valida che host sia valorizzato prima di fidarsi.
  const isValid = !!profiles
    && Object.keys(profiles).length > 0
    && Object.values(profiles).every((p) => !!p.host);

  if (isValid) {
    return profiles!;
  }

  // Fallback: leggi settings.json direttamente (aggira bug VS Code con additionalProperties
  // e con la cache stale su drive di rete). Lettura async + timeout: uno share di rete
  // caduto non deve bloccare l'extension host, e un solo tentativo senza retry.
  try {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders && wsFolders.length > 0) {
      const settingsPath = require('path').join(
        wsFolders[0].uri.fsPath, '.vscode', 'settings.json'
      );
      const raw = await readFileWithTimeout(settingsPath, FALLBACK_READ_TIMEOUT_MS);
      // Rimuovi commenti // e /* */ prima del parse, ignorando quelli dentro stringhe JSON
      const cleaned = stripJsonComments(raw);
      const parsed = JSON.parse(cleaned);
      const directProfiles = parsed['ftpDeploy.profiles'];
      if (directProfiles && Object.keys(directProfiles).length > 0) {
        return directProfiles as ProfileMap;
      }
    }
  } catch (e) {
    logger?.error(`Failed to read .vscode/settings.json directly: ${e}`);
  }

  // Fallback legacy: config flat
  const legacyProfile: ProfileSettings = {
    protocol: cfg.get<'ftp' | 'ftps' | 'sftp'>('protocol', 'ftp'),
    host: cfg.get<string>('host', ''),
    port: cfg.get<number>('port', 21),
    user: cfg.get<string>('user', ''),
    password: cfg.get<string>('password', ''),
    remotePath: cfg.get<string>('remotePath', '/'),
    localRoot: cfg.get<string>('localRoot', ''),
    uploadOnSave: cfg.get<boolean>('uploadOnSave', true),
    ignore: cfg.get<string[]>('ignore', ['.git', 'node_modules', '.vs', '*.user']),
    passive: cfg.get<boolean>('passive', true),
    timeout: cfg.get<number>('timeout', 15000),
    showNotifications: cfg.get<boolean>('showNotifications', true),
    ftpsImplicit: cfg.get<boolean>('ftpsImplicit', false),
    rejectUnauthorized: cfg.get<boolean>('rejectUnauthorized', true),
    privateKeyPath: cfg.get<string>('privateKeyPath', ''),
    passphrase: cfg.get<string>('passphrase', ''),
  };

  return { default: legacyProfile };
}

/**
 * Converte un ProfileSettings in FtpConfig completo,
 * risolvendo localRoot e valori di default.
 */
export function profileToConfig(
  name: string,
  p: ProfileSettings,
  resolvedPassword: string,
  workspaceRoot: string | undefined
): FtpConfig {
  const protocol = p.protocol ?? 'ftp';
  const defaultPort = protocol === 'sftp' ? 22 : 21;

  const rawLocalRoot = p.localRoot ?? '';
  const localRoot = rawLocalRoot
    ? normalizeLocalPath(rawLocalRoot)
    : (workspaceRoot ?? '');

  return {
    protocol,
    host: p.host,
    port: p.port ?? defaultPort,
    user: p.user,
    password: resolvedPassword,
    remotePath: (p.remotePath ?? '/').replace(/\\/g, '/'),
    localRoot,
    uploadOnSave: p.uploadOnSave ?? true,
    ignore: p.ignore ?? ['.git', 'node_modules', '.vs', '*.user'],
    passive: p.passive ?? true,
    timeout: p.timeout ?? 15000,
    showNotifications: p.showNotifications ?? true,
    ftpsImplicit: p.ftpsImplicit ?? false,
    rejectUnauthorized: p.rejectUnauthorized ?? true,
    privateKeyPath: p.privateKeyPath ?? '',
    passphrase: p.passphrase ?? '',
  };
}

/**
 * Gestisce la status bar per selezionare il profilo attivo.
 */
export class ProfileStatusBar {
  private item: vscode.StatusBarItem;
  private currentProfile: string = 'default';
  private onChangeCallback?: (profileName: string) => void;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'ftpDeploy.selectProfile';
    this.item.tooltip = 'FTP Deploy: click to change profile';
    this.update('default');
    this.item.show();
  }

  get active(): string {
    return this.currentProfile;
  }

  setProfile(name: string): void {
    this.currentProfile = name;
    this.update(name);
    this.onChangeCallback?.(name);
  }

  onChange(cb: (profileName: string) => void): void {
    this.onChangeCallback = cb;
  }

  private update(name: string): void {
    const icons: Record<string, string> = {
      dev: '$(debug-alt)',
      development: '$(debug-alt)',
      staging: '$(beaker)',
      stage: '$(beaker)',
      prod: '$(globe)',
      production: '$(globe)',
      default: '$(cloud-upload)',
    };
    const icon = icons[name.toLowerCase()] ?? '$(cloud-upload)';
    this.item.text = `${icon} FTP: ${name}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
