// eslint-disable-next-line @typescript-eslint/no-var-requires
const SftpClient = require('ssh2-sftp-client');

import * as fs from 'fs';
import * as path from 'path';
import { FtpConfig } from './config';
import { Logger } from './logger';
import { localToRemote, UploadStats } from './ftpClient';

interface ISftpClient {
  connect(opts: Record<string, unknown>): Promise<void>;
  put(localPath: string, remotePath: string): Promise<unknown>;
  mkdir(remotePath: string, recursive: boolean): Promise<unknown>;
  end(): Promise<void>;
}

export class SftpDeployClient {
  private client: ISftpClient;
  private logger: Logger;

  constructor(logger: Logger) {
    this.client = new SftpClient() as ISftpClient;
    this.logger = logger;
  }

  async connect(cfg: FtpConfig): Promise<void> {
    const opts: Record<string, unknown> = {
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.user,
    };

    if (cfg.privateKeyPath) {
      opts.privateKey = fs.readFileSync(cfg.privateKeyPath);
      if (cfg.passphrase) {
        opts.passphrase = cfg.passphrase;
      }
    } else {
      opts.password = cfg.password;
    }

    await this.client.connect(opts);
    this.logger.info(`SFTP connesso a ${cfg.host}:${cfg.port || 22}`);
  }

  close(): void {
    this.client.end().catch(() => { /* ignora errori in chiusura */ });
  }

  async uploadFile(localFile: string, remoteDest: string): Promise<void> {
    const remoteDir = remoteDest.substring(0, remoteDest.lastIndexOf('/')) || '/';
    await this.client.mkdir(remoteDir, true);
    await this.client.put(localFile, remoteDest);
    this.logger.info(`✓ ${localFile} → ${remoteDest}`);
  }

  async uploadDirectory(
    localDir: string,
    localRoot: string,
    remotePath: string,
    ignorePatterns: string[]
  ): Promise<UploadStats> {
    const stats: UploadStats = { uploaded: 0, skipped: 0, errors: 0 };
    await this._uploadDirRecursive(localDir, localRoot, remotePath, ignorePatterns, stats);
    return stats;
  }

  private async _uploadDirRecursive(
    currentLocal: string,
    localRoot: string,
    remotePath: string,
    ignorePatterns: string[],
    stats: UploadStats
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
      if (pattern.startsWith('*')) {
        if (name.endsWith(pattern.slice(1))) return true;
      } else {
        if (name === pattern) return true;
      }
    }
    return false;
  }
}
