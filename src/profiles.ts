import * as vscode from 'vscode';
import { FtpConfig, normalizeLocalPath } from './config';

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
export function loadProfiles(): ProfileMap {
  // Prima prova via API VS Code
  const cfg = vscode.workspace.getConfiguration('ftpDeploy');
  const profiles = cfg.get<ProfileMap>('profiles');

  if (profiles && Object.keys(profiles).length > 0) {
    return profiles;
  }

  // Fallback: leggi settings.json direttamente (aggira bug VS Code con additionalProperties)
  try {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders && wsFolders.length > 0) {
      const settingsPath = require('path').join(
        wsFolders[0].uri.fsPath, '.vscode', 'settings.json'
      );
      const raw = require('fs').readFileSync(settingsPath, 'utf8');
      // Rimuovi commenti // prima del parse
      const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const parsed = JSON.parse(cleaned);
      const directProfiles = parsed['ftpDeploy.profiles'];
      if (directProfiles && Object.keys(directProfiles).length > 0) {
        return directProfiles as ProfileMap;
      }
    }
  } catch {
    // ignora errori di lettura file
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
    this.item.tooltip = 'FTP Deploy: clicca per cambiare profilo';
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
