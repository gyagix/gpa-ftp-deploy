import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig, validate } from './config';
import { FtpConfig } from './config';
import { FtpDeployClient, localToRemote, UploadStats } from './ftpClient';
import { Logger } from './logger';
import { resolvePassword, promptAndSavePassword, deletePassword } from './secrets';
import { loadProfiles, profileToConfig, ProfileStatusBar } from './profiles';

type IDeployClient = {
  connect(cfg: FtpConfig): Promise<void>;
  uploadFile(localFile: string, remoteDest: string): Promise<void>;
  uploadDirectory(localDir: string, localRoot: string, remotePath: string, ignore: string[]): Promise<UploadStats>;
  close(): void;
};

function getClient(cfg: FtpConfig, logger: Logger): IDeployClient {
  return new FtpDeployClient(logger);
}

// ── Stato globale ─────────────────────────────────────────────────────────────
let logger: Logger;
let statusBar: ProfileStatusBar;
let extensionContext: vscode.ExtensionContext;

// ── Activate ──────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  logger = new Logger('FTP Deploy');
  statusBar = new ProfileStatusBar();

  logger.info('FTP Deploy activated');

  const lastProfile = context.workspaceState.get<string>('activeProfile', 'default');
  statusBar.setProfile(lastProfile);
  logger.info(`Active profile: ${lastProfile}`);

  // ── Upload on save ──────────────────────────────────────────────────────────
  const onSaveDisposable = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    const cfg = await resolveActiveConfig();
    if (!cfg || !cfg.uploadOnSave) return;

    const localFile = doc.uri.fsPath;
    if (!isUnderRoot(localFile, cfg.localRoot)) {
      logger.debug(`File outside localRoot, skipping: ${localFile}`);
      return;
    }
    await runUploadFile(localFile, cfg);
  });

  // ── Seleziona profilo ───────────────────────────────────────────────────────
  const selectProfileCmd = vscode.commands.registerCommand(
    'ftpDeploy.selectProfile',
    async () => {
      const profiles = await loadProfiles(logger);
      const names = Object.keys(profiles);
      if (names.length === 0) {
        logger.warn('No profiles configured');
        vscode.window.showWarningMessage('FTP Deploy: no profiles configured');
        return;
      }

      const current = statusBar.active;
      const items = names.map((n) => ({
        label: n === current ? `$(check) ${n}` : n,
        description: `${profiles[n].protocol ?? 'ftp'}://${profiles[n].host}${profiles[n].remotePath}`,
        name: n,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title: 'FTP Deploy — Select profile',
        placeHolder: `Active profile: ${current}`,
      });
      if (!picked) return;

      statusBar.setProfile(picked.name);
      await context.workspaceState.update('activeProfile', picked.name);
      logger.info(`Profile changed: ${picked.name}`);
      vscode.window.showInformationMessage(`FTP Deploy: profile "${picked.name}" active`);
    }
  );

  // ── Carica file corrente ────────────────────────────────────────────────────
  const uploadFileCmd = vscode.commands.registerCommand('ftpDeploy.uploadFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { logger.warn('No active editor for upload'); vscode.window.showWarningMessage('FTP Deploy: no file open'); return; }
    const cfg = await resolveActiveConfig();
    if (!cfg) return;
    await runUploadFile(editor.document.uri.fsPath, cfg);
  });

  // ── Carica intera cartella ──────────────────────────────────────────────────
  const uploadFolderCmd = vscode.commands.registerCommand('ftpDeploy.uploadFolder', async () => {
    const cfg = await resolveActiveConfig();
    if (!cfg) return;

    const confirm = await vscode.window.showWarningMessage(
      `Upload the ENTIRE folder "${cfg.localRoot}" to ${cfg.host}${cfg.remotePath}?\n[profile: ${statusBar.active}]`,
      { modal: true },
      'Yes, upload all'
    );
    if (confirm !== 'Yes, upload all') return;
    await runUploadDirectory(cfg.localRoot, cfg);
  });

  // ── Tasto destro nel file explorer ─────────────────────────────────────────
  const uploadSelectedCmd = vscode.commands.registerCommand(
    'ftpDeploy.uploadSelected',
    async (uri: vscode.Uri, uris: vscode.Uri[]) => {
      const cfg = await resolveActiveConfig();
      if (!cfg) return;

      const targets = uris?.length > 0 ? uris : uri ? [uri] : [];
      if (targets.length === 0) {
        logger.warn('No items selected for upload');
        vscode.window.showWarningMessage('FTP Deploy: no items selected');
        return;
      }

      for (const target of targets) {
        const localPath = target.fsPath;
        fs.statSync(localPath).isDirectory()
          ? await runUploadDirectory(localPath, cfg)
          : await runUploadFile(localPath, cfg);
      }
    }
  );

  // ── Salva password nel keychain ─────────────────────────────────────────────
  const savePasswordCmd = vscode.commands.registerCommand('ftpDeploy.savePassword', async () => {
    const profiles = await loadProfiles(logger);
    const names = Object.keys(profiles);
    let profileName = statusBar.active;

    if (names.length > 1) {
      const picked = await vscode.window.showQuickPick(names, {
        title: 'FTP Deploy — Save password to keychain',
      });
      if (!picked) return;
      profileName = picked;
    }

    const profile = profiles[profileName];
    if (!profile) { logger.error(`Profile "${profileName}" not found`); vscode.window.showErrorMessage(`Profile "${profileName}" not found`); return; }

    const pwd = await promptAndSavePassword(context, profileName, profile.host);
    if (pwd !== undefined) {
      vscode.window.showInformationMessage(
        `FTP Deploy: password for profile "${profileName}" saved to keychain ✓`
      );
    }
  });

  // ── Rimuovi password dal keychain ───────────────────────────────────────────
  const deletePasswordCmd = vscode.commands.registerCommand('ftpDeploy.deletePassword', async () => {
    const profiles = await loadProfiles(logger);
    const names = Object.keys(profiles);
    let profileName = statusBar.active;

    if (names.length > 1) {
      const picked = await vscode.window.showQuickPick(names, {
        title: 'FTP Deploy — Remove password from keychain',
      });
      if (!picked) return;
      profileName = picked;
    }

    await deletePassword(context, profileName);
    vscode.window.showInformationMessage(
      `FTP Deploy: password for profile "${profileName}" removed from keychain`
    );
  });

  // ── Test connessione ────────────────────────────────────────────────────────
  const testCmd = vscode.commands.registerCommand('ftpDeploy.testConnection', async () => {
    const cfg = await resolveActiveConfig();
    if (!cfg) return;

    const client = getClient(cfg, logger);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `FTP Deploy: test [${statusBar.active}]…` },
        async () => { await client.connect(cfg); client.close(); }
      );
      vscode.window.showInformationMessage(`FTP Deploy [${statusBar.active}]: ${cfg.host} OK ✓`);
      logger.info(`Connection test OK — profile: ${statusBar.active}, host: ${cfg.host}`);
    } catch (e) {
      vscode.window.showErrorMessage(`FTP Deploy: connection failed — ${e}`);
      logger.error(`Connection test failed: ${e}`);
    }
  });

  // ── Mostra log ──────────────────────────────────────────────────────────────
  const showLogCmd = vscode.commands.registerCommand('ftpDeploy.showLog', () => logger.show());

  // ── Apri configurazione workspace ───────────────────────────────────────────
  const openConfigCmd = vscode.commands.registerCommand('ftpDeploy.openConfig', async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) {
      logger.warn('No workspace open');
      vscode.window.showWarningMessage('FTP Deploy: no workspace open');
      return;
    }

    const vscodeDirUri = vscode.Uri.joinPath(wsRoot, '.vscode');
    const settingsUri  = vscode.Uri.joinPath(vscodeDirUri, 'settings.json');

    // Crea .vscode/ e settings.json con template se non esistono
    try { await vscode.workspace.fs.createDirectory(vscodeDirUri); } catch {}

    let exists = false;
    try { await vscode.workspace.fs.stat(settingsUri); exists = true; } catch {}

    if (!exists) {
      const template = [
        '{',
        '  // ── FTP Deploy ──────────────────────────────────────────────────────',
        '  "ftpDeploy.profiles": {',
        '    "dev": {',
        '      "protocol": "ftp",',
        '      "host": "192.168.1.100",',
        '      "port": 21,',
        '      "user": "ftpuser",',
        '      // password: use the "FTP Deploy: Save password to keychain" command',
        '      "remotePath": "/var/www/myapp",',
        '      "localRoot": "",',
        '      "uploadOnSave": true,',
        '      "passive": true,',
        '      "ignore": [".git", "node_modules", ".vs", "*.user", "Thumbs.db"]',
        '    }',
        '  }',
        '}',
      ].join('\n');
      await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(template, 'utf8'));
    }

    const doc = await vscode.workspace.openTextDocument(settingsUri);
    await vscode.window.showTextDocument(doc);
  });

  // ── Ricarica configurazione ─────────────────────────────────────────────────
  const reloadConfigCmd = vscode.commands.registerCommand('ftpDeploy.reloadConfig', async () => {
    const profiles = await loadProfiles(logger);
    const names = Object.keys(profiles);

    if (names.length === 0) {
      logger.warn('No profiles configured');
      vscode.window.showWarningMessage('FTP Deploy: no profiles configured');
      return;
    }

    const previousProfile = statusBar.active;
    if (!profiles[previousProfile]) {
      const fallback = names[0];
      statusBar.setProfile(fallback);
      await context.workspaceState.update('activeProfile', fallback);
      logger.info(`Profile "${previousProfile}" not found after reload, using "${fallback}"`);
    }

    logger.info(`Configuration reloaded: ${names.length} profile(s), active "${statusBar.active}"`);
    vscode.window.showInformationMessage(
      `FTP Deploy: configuration reloaded — ${names.length} profile(s), active "${statusBar.active}"`
    );
  });

  // ── Wizard: aggiungi profilo ─────────────────────────────────────────────────
  const addProfileCmd = vscode.commands.registerCommand('ftpDeploy.addProfile', async () => {
    // Nome profilo
    const name = await vscode.window.showInputBox({
      title: 'FTP Deploy — Add profile (1/5)',
      prompt: 'Profile name (e.g. dev, staging, prod)',
      placeHolder: 'dev',
      ignoreFocusOut: true,
    });
    if (!name) return;

    // Protocollo
    const proto = await vscode.window.showQuickPick(
      [
        { label: 'ftp',  description: 'Standard FTP (port 21)' },
        { label: 'ftps', description: 'FTP over TLS (port 21 STARTTLS or 990 implicit)' },
        { label: 'sftp', description: 'SFTP over SSH (port 22)' },
      ],
      { title: 'FTP Deploy — Add profile (2/5)', placeHolder: 'Select protocol' }
    );
    if (!proto) return;

    // Host
    const host = await vscode.window.showInputBox({
      title: 'FTP Deploy — Add profile (3/5)',
      prompt: 'Server hostname or IP address',
      placeHolder: '192.168.1.100',
      ignoreFocusOut: true,
    });
    if (!host) return;

    // User
    const user = await vscode.window.showInputBox({
      title: 'FTP Deploy — Add profile (4/5)',
      prompt: 'Username',
      ignoreFocusOut: true,
    });
    if (!user) return;

    // Remote path
    const remotePath = await vscode.window.showInputBox({
      title: 'FTP Deploy — Add profile (5/5)',
      prompt: 'Remote folder on the server (absolute POSIX path)',
      placeHolder: '/var/www/myapp',
      ignoreFocusOut: true,
    });
    if (!remotePath) return;

    // Costruisci il blocco da aggiungere
    const defaultPort = proto.label === 'sftp' ? 22 : 21;
    const newProfile: Record<string, unknown> = {
      protocol: proto.label,
      host,
      port: defaultPort,
      user,
      remotePath,
      uploadOnSave: true,
      passive: true,
      ignore: ['.git', 'node_modules', '.vs', '*.user', 'Thumbs.db'],
    };

    // Leggi il settings.json attuale e aggiungi il profilo
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) return;

    const settingsUri = vscode.Uri.joinPath(wsRoot, '.vscode', 'settings.json');
    let settings: Record<string, unknown> = {};

    try {
      const raw = await vscode.workspace.fs.readFile(settingsUri);
      // Parsing robusto: rimuove commenti stile // prima del JSON.parse
      const cleaned = Buffer.from(raw).toString('utf8').replace(/\/\/[^\n]*/g, '');
      settings = JSON.parse(cleaned);
    } catch {
      settings = {};
    }

    if (!settings['ftpDeploy.profiles'] || typeof settings['ftpDeploy.profiles'] !== 'object') {
      settings['ftpDeploy.profiles'] = {};
    }
    (settings['ftpDeploy.profiles'] as Record<string, unknown>)[name] = newProfile;

    await vscode.workspace.fs.writeFile(
      settingsUri,
      Buffer.from(JSON.stringify(settings, null, 2), 'utf8')
    );

    // Offri subito di salvare la password nel keychain
    const savePwd = await vscode.window.showInformationMessage(
      `Profile "${name}" added ✓ — Save the password to keychain now?`,
      'Yes, save password',
      'Later'
    );
    if (savePwd === 'Yes, save password') {
      await promptAndSavePassword(context, name, host);
    }

    // Aggiorna la status bar al nuovo profilo
    statusBar.setProfile(name);
    await context.workspaceState.update('activeProfile', name);

    // Apri il settings.json per revisione
    const doc = await vscode.workspace.openTextDocument(settingsUri);
    await vscode.window.showTextDocument(doc);
  });

  context.subscriptions.push(
    onSaveDisposable,
    selectProfileCmd,
    uploadFileCmd,
    uploadFolderCmd,
    uploadSelectedCmd,
    savePasswordCmd,
    deletePasswordCmd,
    testCmd,
    showLogCmd,
    openConfigCmd,
    reloadConfigCmd,
    addProfileCmd,
    statusBar,
    { dispose: () => logger.dispose() }
  );
}

export function deactivate() {}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveActiveConfig(): Promise<FtpConfig | null> {
  const profiles = await loadProfiles(logger);
  const names = Object.keys(profiles);

  if (names.length === 0) {
    logger.error('No profiles configured in ftpDeploy.profiles');
    vscode.window.showErrorMessage('FTP Deploy: no profiles configured in ftpDeploy.profiles');
    return null;
  }

  let profileName = statusBar.active;

  // Se il profilo attivo non esiste, usa il primo disponibile
  if (!profiles[profileName]) {
    const previousProfile = profileName;
    profileName = names[0];
    statusBar.setProfile(profileName);
    await extensionContext.workspaceState.update('activeProfile', profileName);
    logger.info(`Profile "${previousProfile}" not found, using "${profileName}"`);
  }

  const profile = profiles[profileName];

  const password = await resolvePassword(
    extensionContext,
    profileName,
    profile.host,
    profile.password ?? '',
    logger
  );
  if (password === null) return null;

  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const cfg = profileToConfig(profileName, profile, password, wsRoot);

  const err = validate(cfg);
  if (err) {
    logger.error(`Profile [${profileName}] validation failed: ${err}`);
    vscode.window.showErrorMessage(`FTP Deploy [${profileName}]: ${err}`);
    return null;
  }
  return cfg;
}

function isUnderRoot(filePath: string, localRoot: string): boolean {
  const rel = path.relative(localRoot, filePath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function runUploadFile(localFile: string, cfg: FtpConfig): Promise<void> {
  let remoteDest: string;
  try {
    remoteDest = localToRemote(localFile, cfg.localRoot, cfg.remotePath);
  } catch (e) {
    logger.error(`Remote path calculation failed: ${e}`);
    return;
  }

  const client = getClient(cfg, logger);
  const shortName = path.basename(localFile);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `${cfg.protocol.toUpperCase()} ↑ ${shortName} [${statusBar.active}]`,
        cancellable: false,
      },
      async () => {
        await client.connect(cfg);
        try { await client.uploadFile(localFile, remoteDest); }
        finally { client.close(); }
      }
    );
    if (cfg.showNotifications) {
      vscode.window.showInformationMessage(`FTP Deploy: ${shortName} uploaded ✓`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`FTP Deploy: upload error ${shortName} — ${e}`);
    logger.error(`Upload failed for ${localFile}: ${e}`);
  }
}

async function runUploadDirectory(localDir: string, cfg: FtpConfig): Promise<void> {
  const client = getClient(cfg, logger);
  const shortName = path.basename(localDir);
  let stats: UploadStats = { uploaded: 0, skipped: 0, errors: 0 };

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `FTP Deploy [${statusBar.active}]: uploading "${shortName}"…`,
        cancellable: false,
      },
      async (progress) => {
        await client.connect(cfg);
        progress.report({ message: 'Connected, upload in progress…' });
        try {
          stats = await client.uploadDirectory(localDir, cfg.localRoot, cfg.remotePath, cfg.ignore);
        } finally {
          client.close();
        }
      }
    );

    const msg = `FTP Deploy: "${shortName}" → ${stats.uploaded} uploaded, ${stats.skipped} skipped, ${stats.errors} errors`;
    logger.info(msg);
    if (cfg.showNotifications || stats.errors > 0) {
      stats.errors > 0
        ? vscode.window.showWarningMessage(msg)
        : vscode.window.showInformationMessage(msg);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`FTP Deploy: folder upload error — ${e}`);
    logger.error(`Upload failed for directory ${localDir}: ${e}`);
  }
}
