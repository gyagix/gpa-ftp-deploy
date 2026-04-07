import * as vscode from 'vscode';
import * as path from 'path';

export interface FtpConfig {
  protocol: 'ftp' | 'ftps' | 'sftp';
  host: string;
  port: number;
  user: string;
  password: string;
  remotePath: string;
  localRoot: string;
  uploadOnSave: boolean;
  ignore: string[];
  passive: boolean;
  timeout: number;
  showNotifications: boolean;
  ftpsImplicit: boolean;
  rejectUnauthorized: boolean;
  privateKeyPath: string;
  passphrase: string;
}

/**
 * Normalizza qualsiasi path locale (lettera di rete, UNC, POSIX) in
 * un path assoluto con separatori corretti per Node.js su Windows.
 *
 * Esempi:
 *   Z:\progetto            → Z:\progetto
 *   \\server\share\proj    → \\server\share\proj
 *   /z/progetto (WSL/Git)  → Z:\progetto  (euristica)
 */
export function normalizeLocalPath(inputPath: string): string {
  if (!inputPath) return '';

  // Rimuovi eventuali slash/backslash finali
  let p = inputPath.replace(/[/\\]+$/, '');

  // Già un path Windows assoluto (lettera o UNC) → ok
  if (/^[A-Za-z]:/.test(p) || p.startsWith('\\\\')) {
    return p;
  }

  // Path POSIX tipo /z/progetto → converti in Z:\progetto
  const posixDriveMatch = p.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (posixDriveMatch) {
    const drive = posixDriveMatch[1].toUpperCase();
    const rest = (posixDriveMatch[2] || '').replace(/\//g, '\\');
    return `${drive}:${rest || '\\'}`;
  }

  // Path relativo → lo risolviamo rispetto alla workspace root
  const wsRoot = getWorkspaceRoot();
  if (wsRoot) {
    return path.resolve(wsRoot, p);
  }

  return p;
}

export function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  // Per workspace su unità di rete il fsPath restituisce già il path UNC/drive corretto
  return folders[0].uri.fsPath;
}

export function getConfig(): FtpConfig {
  const cfg = vscode.workspace.getConfiguration('ftpDeploy');

  const rawLocalRoot = cfg.get<string>('localRoot', '');
  const localRoot = rawLocalRoot
    ? normalizeLocalPath(rawLocalRoot)
    : (getWorkspaceRoot() || '');

  const protocol = cfg.get<'ftp' | 'ftps' | 'sftp'>('protocol', 'ftp');
  const defaultPort = protocol === 'sftp' ? 22 : 21;

  return {
    protocol,
    host: cfg.get<string>('host', ''),
    port: cfg.get<number>('port', defaultPort),
    user: cfg.get<string>('user', ''),
    password: cfg.get<string>('password', ''),
    remotePath: cfg.get<string>('remotePath', '/').replace(/\\/g, '/'),
    localRoot,
    uploadOnSave: cfg.get<boolean>('uploadOnSave', true),
    ignore: cfg.get<string[]>('ignore', ['.git', 'node_modules', '.vs']),
    passive: cfg.get<boolean>('passive', true),
    timeout: cfg.get<number>('timeout', 15000),
    showNotifications: cfg.get<boolean>('showNotifications', true),
    ftpsImplicit: cfg.get<boolean>('ftpsImplicit', false),
    rejectUnauthorized: cfg.get<boolean>('rejectUnauthorized', true),
    privateKeyPath: cfg.get<string>('privateKeyPath', ''),
    passphrase: cfg.get<string>('passphrase', ''),
  };
}

export function validate(cfg: FtpConfig): string | null {
  if (!cfg.host) return 'ftpDeploy.host non configurato';
  if (!cfg.user) return 'ftpDeploy.user non configurato';
  if (!cfg.localRoot) return 'Impossibile determinare la cartella locale radice';
  return null;
}
