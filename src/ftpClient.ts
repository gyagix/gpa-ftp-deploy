import * as ftp from 'basic-ftp';
import * as fs from 'fs';
import * as path from 'path';
import { FtpConfig } from './config';
import { Logger } from './logger';

/**
 * Converte un path locale assoluto nel path remoto corrispondente.
 *
 * localRoot : Z:\progetti\myapp   (o \\server\share\myapp)
 * localFile : Z:\progetti\myapp\sub\file.asp
 * remotePath: /var/www/myapp
 * → risultato: /var/www/myapp/sub/file.asp
 */
export function localToRemote(
  localFile: string,
  localRoot: string,
  remotePath: string
): string {
  // Normalizza entrambi i path in lowercase per il confronto su Windows
  const normalRoot = localRoot.replace(/[/\\]+$/, '');
  const normalFile = localFile;

  // Calcola il percorso relativo (usa path.relative che gestisce drive/UNC)
  const relative = path.relative(normalRoot, normalFile);

  if (relative.startsWith('..')) {
    throw new Error(
      `Il file "${localFile}" è fuori dalla cartella radice "${localRoot}"`
    );
  }

  // Converti separatori Windows in slash POSIX
  const posixRelative = relative.split(path.sep).join('/');
  const remoteBase = remotePath.replace(/\/+$/, '');

  return posixRelative ? `${remoteBase}/${posixRelative}` : remoteBase;
}

export interface UploadStats {
  uploaded: number;
  skipped: number;
  errors: number;
}

export class FtpDeployClient {
  private client: ftp.Client;
  private logger: Logger;

  constructor(logger: Logger) {
    this.client = new ftp.Client();
    this.logger = logger;
  }

  async connect(cfg: FtpConfig): Promise<void> {
    this.client.ftp.verbose = false;

    const isFtps = cfg.protocol === 'ftps';

    await this.client.access({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      // secure: true  → FTPS esplicito (STARTTLS su porta 21)
      // secure: 'implicit' → FTPS implicito (porta 990)
      secure: isFtps ? (cfg.ftpsImplicit ? 'implicit' : true) : false,
      secureOptions: isFtps ? { rejectUnauthorized: cfg.rejectUnauthorized ?? true } : undefined,
    });

    if (cfg.passive) {
      this.client.ftp.socket.setKeepAlive(true, 5000);
    }

    const proto = isFtps ? 'FTPS' : 'FTP';
    this.logger.info(`${proto} connesso a ${cfg.host}:${cfg.port}`);
  }

  close(): void {
    this.client.close();
  }

  /**
   * Carica un singolo file garantendo che la cartella remota esista.
   */
  async uploadFile(localFile: string, remoteDest: string): Promise<void> {
    const remoteDir = remoteDest.substring(0, remoteDest.lastIndexOf('/')) || '/';
    await this.ensureDir(remoteDir);
    await this.client.uploadFrom(localFile, remoteDest);
    this.logger.info(`✓ ${localFile} → ${remoteDest}`);
  }

  /**
   * Crea ricorsivamente le cartelle remote se non esistono.
   * basic-ftp espone ensureDir() che fa proprio questo.
   */
  async ensureDir(remoteDir: string): Promise<void> {
    await this.client.ensureDir(remoteDir);
    // Torna alla root dopo ensureDir (basic-ftp cambia la cwd)
    await this.client.cd('/');
  }

  /**
   * Carica ricorsivamente una cartella intera rispettando la gerarchia.
   * Salta i file/cartelle che corrispondono ai pattern di ignore.
   */
  async uploadDirectory(
    localDir: string,
    localRoot: string,
    remotePath: string,
    ignorePatterns: string[]
  ): Promise<{ uploaded: number; skipped: number; errors: number }> {
    const stats = { uploaded: 0, skipped: 0, errors: 0 };
    await this._uploadDirRecursive(localDir, localRoot, remotePath, ignorePatterns, stats);
    return stats;
  }

  private async _uploadDirRecursive(
    currentLocal: string,
    localRoot: string,
    remotePath: string,
    ignorePatterns: string[],
    stats: { uploaded: number; skipped: number; errors: number }
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentLocal, { withFileTypes: true });
    } catch (e) {
      this.logger.error(`Impossibile leggere cartella: ${currentLocal}: ${e}`);
      stats.errors++;
      return;
    }

    for (const entry of entries) {
      const localFull = path.join(currentLocal, entry.name);

      if (this.shouldIgnore(entry.name, ignorePatterns)) {
        this.logger.debug(`Skip (ignore): ${localFull}`);
        stats.skipped++;
        continue;
      }

      if (entry.isDirectory()) {
        await this._uploadDirRecursive(localFull, localRoot, remotePath, ignorePatterns, stats);
      } else if (entry.isFile()) {
        try {
          const remoteDest = localToRemote(localFull, localRoot, remotePath);
          await this.uploadFile(localFull, remoteDest);
          stats.uploaded++;
        } catch (e) {
          this.logger.error(`Errore upload ${localFull}: ${e}`);
          stats.errors++;
        }
      }
    }
  }

  private shouldIgnore(name: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      // Supporta wildcard semplici tipo *.user
      if (pattern.startsWith('*')) {
        const ext = pattern.slice(1); // es: .user
        if (name.endsWith(ext)) return true;
      } else {
        if (name === pattern) return true;
      }
    }
    return false;
  }
}
