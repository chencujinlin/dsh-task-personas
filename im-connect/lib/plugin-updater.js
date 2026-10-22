import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const PLUGIN_UPDATE_HEADER = 'x-michengai-plugin-update';
export const PLUGIN_UPDATE_IPC = 'apply-plugin-updates';
function header(request, name) {
    const value = request.headers?.[name];
    return Array.isArray(value) ? value[0] : value;
}
function isLoopbackAddress(value) {
    const address = value?.toLowerCase().replace(/^\[|\]$/g, '');
    return address === 'localhost' || address === 'localhost.' || address === '::1'
        || address?.startsWith('127.') === true || address?.startsWith('::ffff:127.') === true;
}
export function isTrustedUpdateRequest(request) {
    if (header(request, PLUGIN_UPDATE_HEADER) !== '1')
        return false;
    if (!isLoopbackAddress(request.socket?.remoteAddress))
        return false;
    const site = header(request, 'sec-fetch-site');
    if (site !== undefined && site !== 'same-origin')
        return false;
    const host = header(request, 'host');
    if (host === undefined || host === '')
        return false;
    const origin = header(request, 'origin');
    // 官方 Desktop 从 dsh-app://app 转发时会去掉 origin。只接受本机 Host，浏览器带来的跨源 origin 仍然拒绝。
    if (origin === undefined || origin === '') {
        try {
            return isLoopbackAddress(new URL(`http://${host}`).hostname);
        }
        catch {
            return false;
        }
    }
    try {
        const url = new URL(origin);
        return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackAddress(url.hostname) && url.host === host;
    }
    catch {
        return false;
    }
}
function validProfileName(value) {
    return typeof value === 'string' && value !== '' && value !== '.' && value !== '..'
        && !value.includes('/') && !value.includes('\\') && !/[\0-\x1f\x7f]/.test(value);
}
function profileNameFromArgv(argv) {
    for (let index = 2; index < argv.length; index += 1) {
        if (argv[index] === '--profile')
            return argv[index + 1];
        if (argv[index]?.startsWith('--profile='))
            return argv[index].slice('--profile='.length);
    }
    return argv[2] === 'web' ? 'web' : undefined;
}
export function isDshCliEntry(entry, manifest, packageRoot) {
    if (typeof manifest !== 'object' || manifest === null)
        return false;
    const value = manifest;
    if (value.name !== '@deepseek-ai/dsh')
        return false;
    const bin = typeof value.bin === 'string'
        ? value.bin
        : typeof value.bin === 'object' && value.bin !== null
            ? value.bin.dsh
            : undefined;
    return typeof bin === 'string' && bin !== '' && !isAbsolute(bin) && resolve(packageRoot, bin) === resolve(entry);
}
function cliEntry(argv = process.argv, cwd = process.cwd(), exists = existsSync) {
    const value = argv[1];
    if (value === undefined || value === '')
        return undefined;
    const entry = value.startsWith('file:') ? fileURLToPath(value) : resolve(cwd, value);
    if (!exists(entry))
        return undefined;
    for (let directory = dirname(entry);;) {
        const manifestPath = resolve(directory, 'package.json');
        if (exists(manifestPath)) {
            try {
                if (isDshCliEntry(entry, JSON.parse(readFileSync(manifestPath, 'utf8')), directory))
                    return entry;
            }
            catch {
                // Keep searching parent directories when a package manifest is unreadable.
            }
        }
        const parent = dirname(directory);
        if (parent === directory)
            return undefined;
        directory = parent;
    }
}
function optionalService(ctx, name) {
    try {
        return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    }
    catch {
        return undefined;
    }
}
function isOfficialDesktopHostEntry(entry) {
    if (entry === undefined || entry === '')
        return false;
    return entry.replaceAll('\\', '/').includes('/dsh-desktop-host/');
}
function stringEnvironment(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const env = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string')
            env[key] = item;
    }
    return Object.keys(env).length === 0 ? undefined : env;
}
function packageManagerFrom(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const item = value;
    if (typeof item.command !== 'string' || item.command === '')
        return undefined;
    if (!Array.isArray(item.args) || !item.args.every(arg => typeof arg === 'string'))
        return undefined;
    const env = stringEnvironment(item.env);
    return { command: item.command, args: item.args, ...(env === undefined ? {} : { env }) };
}
function packageManagerFromArgv(argv, exists, execPath, pathEnv) {
    if (!isOfficialDesktopHostEntry(argv[1]))
        return undefined;
    const pnpm = argv[5];
    if (typeof pnpm !== 'string' || !isAbsolute(pnpm) || !exists(pnpm))
        return undefined;
    const bin = argv[6];
    const path = typeof bin === 'string' && bin !== '' ? `${bin}${delimiter}${pathEnv ?? ''}` : pathEnv;
    return { command: execPath, args: ['--expose-internals', pnpm], env: { ELECTRON_RUN_AS_NODE: '1', ...(typeof path === 'string' && path !== '' ? { PATH: path } : {}) } };
}
function pluginManagerFrom(value) {
    if (value === null || typeof value !== 'object' || typeof value.installBundle !== 'function')
        return undefined;
    return value;
}
export function resolveUpdateRuntime(ctx, options = {}) {
    const argv = options.argv ?? process.argv;
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const home = options.homeDir ?? homedir();
    const exists = options.exists ?? existsSync;
    const execPath = options.execPath ?? process.execPath;
    const profiles = optionalService(ctx, 'desktopProfiles');
    const desktopPnpm = optionalService(ctx, 'desktopPnpm');
    if (profiles?.current !== undefined) {
        const current = profiles.current;
        if (!validProfileName(current?.name) || typeof current.dir !== 'string' || !isAbsolute(current.dir)) {
            throw new Error('当前 Desktop Profile 信息无效，请重启后重试。');
        }
        const runnable = typeof desktopPnpm?.runPlugin === 'function';
        return { profileName: current.name, profileDir: resolve(current.dir), officialDesktop: false, canAutoUpdate: runnable, ...(runnable ? { desktopPnpm } : {}) };
    }
    const launched = optionalService(ctx, 'profileContext');
    const official = isOfficialDesktopHostEntry(argv[1]) || launched?.name === 'desktop';
    const launchedDir = typeof launched?.dir === 'string' && isAbsolute(launched.dir) ? resolve(launched.dir) : undefined;
    const projectDir = official && typeof argv[3] === 'string' && isAbsolute(argv[3]) ? resolve(argv[3]) : undefined;
    const cwdProfile = official && exists(resolve(cwd, 'package.json')) ? resolve(cwd) : undefined;
    const profileDir = launchedDir ?? projectDir ?? cwdProfile ?? resolve(env.DSH_PROFILE_DIR ?? resolve(home, '.dsh', 'profiles', 'web'));
    const selected = profileNameFromArgv(argv);
    const profileName = validProfileName(launched?.name) ? launched.name : official ? 'desktop' : validProfileName(selected) ? selected : validProfileName(basename(profileDir)) ? basename(profileDir) : 'web';
    const packageManager = official ? packageManagerFrom(launched?.packageManager) ?? packageManagerFromArgv(argv, exists, execPath, env.PATH) : undefined;
    const pluginManager = official && packageManager === undefined ? pluginManagerFrom(optionalService(ctx, 'pluginManager')) : undefined;
    const entry = official ? undefined : cliEntry(argv, cwd, exists);
    return {
        profileName, profileDir, officialDesktop: official,
        canAutoUpdate: packageManager !== undefined || pluginManager !== undefined || entry !== undefined,
        ...(packageManager === undefined ? {} : { packageManager }),
        ...(pluginManager === undefined ? {} : { pluginManager }),
        ...(entry === undefined ? {} : { cliEntry: entry }),
    };
}
export function shouldNotifyParent(target, send = process.send) {
    return target.officialDesktop !== true && target.desktopPnpm === undefined && target.packageManager === undefined && typeof send === 'function';
}
function runtime(ctx) {
    return resolveUpdateRuntime(ctx);
}
function parseSemver(value) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (match === null)
        return undefined;
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split('.') ?? [] };
}
export function isNewerVersion(currentValue, candidateValue) {
    const current = parseSemver(currentValue);
    const candidate = parseSemver(candidateValue);
    if (current === undefined || candidate === undefined)
        return false;
    for (let index = 0; index < 3; index += 1) {
        if (candidate.core[index] !== current.core[index])
            return candidate.core[index] > current.core[index];
    }
    return comparePrerelease(candidate.prerelease, current.prerelease) > 0;
}
function comparePrerelease(left, right) {
    if (left.length === 0 || right.length === 0)
        return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const a = left[index];
        const b = right[index];
        if (a === undefined || b === undefined)
            return a === b ? 0 : a === undefined ? -1 : 1;
        if (a === b)
            continue;
        const aNumeric = /^\d+$/.test(a);
        const bNumeric = /^\d+$/.test(b);
        if (aNumeric && bNumeric) {
            const aNumber = BigInt(a);
            const bNumber = BigInt(b);
            if (aNumber !== bNumber)
                return aNumber > bNumber ? 1 : -1;
            continue;
        }
        if (aNumeric !== bNumeric)
            return aNumeric ? -1 : 1;
        return a > b ? 1 : -1;
    }
    return 0;
}
let latestCache;
async function latestVersion(packageName) {
    if (latestCache?.packageName === packageName && Date.now() < latestCache.expiresAt)
        return latestCache.version;
    try {
        const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok)
            return undefined;
        const value = await response.json();
        if (typeof value.version !== 'string' || value.version === '')
            return undefined;
        latestCache = { packageName, version: value.version, expiresAt: Date.now() + 5 * 60_000 };
        return value.version;
    }
    catch {
        return undefined;
    }
}
async function currentVersion(manifestUrl) {
    const value = JSON.parse(await readFile(manifestUrl, 'utf8'));
    if (typeof value.version !== 'string' || value.version === '')
        throw new Error('无法读取当前插件版本。');
    return value.version;
}
async function status(options, target) {
    const current = await currentVersion(options.manifestUrl);
    const latest = await latestVersion(options.packageName);
    return {
        packageName: options.packageName,
        currentVersion: current,
        ...(latest === undefined ? {} : { latestVersion: latest }),
        latestCheckFailed: latest === undefined,
        updateAvailable: latest !== undefined && isNewerVersion(current, latest),
        profileName: target.profileName,
        canAutoUpdate: target.canAutoUpdate,
    };
}
function releaseAgeSpec(packageSpec) {
    const at = packageSpec.lastIndexOf('@');
    if (at <= 0)
        return undefined;
    const name = packageSpec.slice(0, at);
    const version = packageSpec.slice(at + 1);
    if (!isPackageName(name) || !isReleaseVersion(version))
        return undefined;
    return { name, version };
}
function isPackageName(name) {
    return /^@[^/\s]+\/[^/\s]+$/.test(name) || /^[^@/\s]+$/.test(name);
}
function isReleaseVersion(version) {
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}
function unreadableReleaseAgeExclude() {
    return new Error('发布年龄白名单无法安全合并，已停止更新，避免这个 profile 之后无法安装插件。');
}
function excludeEntry(indent, name, versions, comment = '') {
    const entry = `${indent}- '${name}@${versions.join(' || ')}'`;
    return comment === '' ? entry : `${entry} ${comment}`;
}
function parseExcludeLine(line) {
    const dash = line.indexOf('-');
    if (!/^\s+-/.test(line) || dash < 0)
        return undefined;
    const indent = line.slice(0, dash);
    const raw = line.slice(dash + 1).trim();
    let body = raw;
    let comment = '';
    if (raw.startsWith("'") || raw.startsWith('"')) {
        const quote = raw[0] ?? "'";
        const end = raw.lastIndexOf(quote);
        if (end <= 0)
            return undefined;
        const rest = raw.slice(end + 1).trim();
        if (rest !== '' && !rest.startsWith('#'))
            return undefined;
        if (rest.startsWith('#'))
            comment = rest;
        body = raw.slice(1, end);
    }
    else if (raw.includes('#'))
        return undefined;
    if (body.includes('#'))
        return undefined;
    const versionAt = body.lastIndexOf('@');
    if (versionAt > 0) {
        const name = body.slice(0, versionAt);
        const versions = body.slice(versionAt + 1).split(' || ');
        if (isPackageName(name) && versions.every(isReleaseVersion))
            return { indent, name, versions, comment };
        return undefined;
    }
    if (isPackageName(body) || /^@[^/\s]+\/\*$/.test(body))
        return { indent, name: body, versions: undefined, comment };
    return undefined;
}
/** 把刚安装的精确版本并进 profile 白名单。pnpm 每个包名只认第一条，所以必须并进已有 union，不能另起一行，也不能收成裸包名。 */
export function mergeMinimumReleaseAgeExclude(yaml, packageSpec) {
    const spec = releaseAgeSpec(packageSpec);
    if (spec === undefined)
        throw new Error('更新版本无法写入发布年龄白名单，已停止更新。');
    const eol = yaml.includes('\r\n') ? '\r\n' : '\n';
    const text = yaml.replaceAll('\r\n', '\n');
    const next = mergeReleaseAgeText(text, spec.name, spec.version);
    return eol === '\r\n' ? next.replaceAll('\n', '\r\n') : next;
}
function mergeReleaseAgeText(yaml, name, version) {
    if (/minimumReleaseAgeExclude:[^\n\r]/.test(yaml))
        throw unreadableReleaseAgeExclude();
    const marker = /(?:^|\n)minimumReleaseAgeExclude:[ \t]*(?:\n|$)/.exec(yaml);
    if (marker === null) {
        const base = yaml.endsWith('\n') || yaml.length === 0 ? yaml : `${yaml}\n`;
        const gap = base.length === 0 || base.endsWith('\n\n') ? '' : '\n';
        return `${base}${gap}minimumReleaseAgeExclude:\n  - '${name}@${version}'\n`;
    }
    const keyAt = (marker.index ?? 0) + (marker[0].startsWith('\n') ? 1 : 0);
    let cursor = keyAt + 'minimumReleaseAgeExclude:'.length;
    while (cursor < yaml.length && (yaml[cursor] === ' ' || yaml[cursor] === '\t'))
        cursor += 1;
    if (yaml[cursor] !== '\n')
        throw unreadableReleaseAgeExclude();
    const bodyStart = cursor + 1;
    const lines = [];
    let bodyEnd = bodyStart;
    while (bodyEnd <= yaml.length) {
        const nextNl = yaml.indexOf('\n', bodyEnd);
        const lineEnd = nextNl === -1 ? yaml.length : nextNl;
        const line = yaml.slice(bodyEnd, lineEnd);
        const ended = line.trim() !== '' && !/^[ \t]*#/.test(line) && !/^[ \t]/.test(line);
        if (ended)
            break;
        if (line.trim() !== '' && !/^[ \t]*#/.test(line) && !/^[ \t]+-/.test(line))
            throw unreadableReleaseAgeExclude();
        lines.push(line);
        if (nextNl === -1) {
            bodyEnd = yaml.length;
            break;
        }
        bodyEnd = nextNl + 1;
        if (bodyEnd === yaml.length)
            break;
    }
    let ours;
    const rewritten = lines.map((line, index) => {
        if (line.trim() === '' || /^[ \t]*#/.test(line))
            return line;
        const parsed = parseExcludeLine(line);
        if (parsed === undefined)
            throw unreadableReleaseAgeExclude();
        if (parsed.name !== name)
            return line;
        if (ours === undefined) {
            ours = { index, indent: parsed.indent, versions: parsed.versions, comment: parsed.comment };
            return line;
        }
        if (ours.versions !== undefined && parsed.versions !== undefined)
            ours.versions = [...ours.versions, ...parsed.versions.filter((item) => !ours?.versions?.includes(item))];
        return '';
    });
    if (ours?.versions === undefined && ours !== undefined)
        return yaml;
    const indent = ours?.indent ?? lines.find((line) => /^[ \t]+-/.test(line))?.match(/^([ \t]+)/)?.[1] ?? '  ';
    const versions = ours?.versions === undefined ? [version] : ours.versions.includes(version) ? ours.versions : [...ours.versions, version];
    const entry = excludeEntry(indent, name, versions, ours?.comment ?? '');
    if (ours === undefined)
        rewritten.push(entry);
    else
        rewritten[ours.index] = entry;
    const body = rewritten.filter((line) => line !== '').join('\n');
    const prefix = yaml.slice(0, bodyStart);
    const suffix = yaml.slice(bodyEnd);
    const joined = `${prefix}${body}${body.length === 0 || body.endsWith('\n') ? '' : '\n'}${suffix}`;
    return joined.endsWith('\n') ? joined : `${joined}\n`;
}
async function guardReleaseAgeExclude(profileDir, packageSpec) {
    const file = resolve(profileDir, 'pnpm-workspace.yaml');
    const current = existsSync(file) ? await readFile(file, 'utf8') : 'packages:\n  - .\n';
    mergeMinimumReleaseAgeExclude(current, packageSpec);
}
async function replaceTextFile(file, next) {
    const tmp = `${file}.${process.pid}.tmp`;
    const backup = `${file}.${process.pid}.bak`;
    await writeFile(tmp, next, 'utf8');
    try {
        await rename(tmp, file);
        return;
    }
    catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
            await unlink(tmp).catch(() => { });
            throw error;
        }
    }
    await unlink(backup).catch(() => { });
    await rename(file, backup);
    try {
        await rename(tmp, file);
    }
    catch (error) {
        await rename(backup, file).catch(() => { });
        await unlink(tmp).catch(() => { });
        throw error;
    }
    await unlink(backup).catch(() => { });
}
export async function recordReleaseAgeExclude(profileDir, packageSpec) {
    const file = resolve(profileDir, 'pnpm-workspace.yaml');
    const current = existsSync(file) ? await readFile(file, 'utf8') : 'packages:\n  - .\n';
    const next = mergeMinimumReleaseAgeExclude(current, packageSpec);
    if (next !== current)
        await replaceTextFile(file, next);
}
async function runCliInstall(target, packageSpec) {
    if (target.cliEntry === undefined)
        throw new Error('当前环境不支持自动更新，请使用手工更新命令。');
    await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [target.cliEntry, 'plugin', '--profile', target.profileName, 'add', '--config.minimumReleaseAge=0', packageSpec, '--registry=https://registry.npmjs.org/'], {
            cwd: target.profileDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
        });
        let detail = '';
        child.stdout?.on('data', chunk => { detail = (detail + String(chunk)).slice(-4_000); });
        child.stderr?.on('data', chunk => { detail = (detail + String(chunk)).slice(-4_000); });
        const timer = setTimeout(() => { child.kill(); reject(new Error('更新超时，请改用手工更新。')); }, 10 * 60_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => {
            clearTimeout(timer);
            if (code === 0)
                resolvePromise();
            else
                reject(new Error(detail.trim() || `更新进程退出码 ${String(code)}`));
        });
    });
}
async function install(target, packageSpec) {
    if (target.desktopPnpm !== undefined) {
        await guardReleaseAgeExclude(target.profileDir, packageSpec);
        const handle = target.desktopPnpm.runPlugin(['add', '--config.minimumReleaseAge=0', packageSpec, '--registry=https://registry.npmjs.org/'], target.profileDir);
        const result = await handle.done;
        if (result.exitCode !== 0)
            throw new Error(`更新进程退出码 ${String(result.exitCode)}。`);
        await recordReleaseAgeExclude(target.profileDir, packageSpec);
        return;
    }
    if (target.packageManager !== undefined) {
        await guardReleaseAgeExclude(target.profileDir, packageSpec);
        const manager = target.packageManager;
        await new Promise((resolvePromise, reject) => {
            const child = spawn(manager.command, [...manager.args, 'add', '--config.minimumReleaseAge=0', packageSpec, '--registry=https://registry.npmjs.org/'], {
                cwd: target.profileDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...manager.env, NO_COLOR: '1' },
            });
            let detail = '';
            child.stdout?.on('data', chunk => { detail = (detail + String(chunk)).slice(-4000); });
            child.stderr?.on('data', chunk => { detail = (detail + String(chunk)).slice(-4000); });
            const timer = setTimeout(() => { child.kill(); reject(new Error('更新超时，请改用手工更新。')); }, 10 * 60_000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); if (code === 0)
                resolvePromise();
            else
                reject(new Error(detail.trim() || `更新进程退出码 ${String(code)}`)); });
        });
        await recordReleaseAgeExclude(target.profileDir, packageSpec);
        return;
    }
    if (target.pluginManager !== undefined) {
        await guardReleaseAgeExclude(target.profileDir, packageSpec);
        const result = await target.pluginManager.installBundle(packageSpec);
        if (result.application === 'applied' || result.application === 'restart-required' || result.application === 'overridden') {
            await recordReleaseAgeExclude(target.profileDir, packageSpec);
            return;
        }
        throw new Error(result.error?.message || result.packageResult?.output || '更新失败，请查看服务端日志。');
    }
    await guardReleaseAgeExclude(target.profileDir, packageSpec);
    await runCliInstall(target, packageSpec);
    await recordReleaseAgeExclude(target.profileDir, packageSpec);
}
function json(response, statusCode, value) {
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
}
function publicError(error) {
    const message = error instanceof Error ? error.message : '更新暂不可用。';
    return /[A-Za-z]:[\\/]|\/(?:home|root|Users|var|tmp)\//.test(message) ? '更新失败，请查看服务端日志。' : message;
}
export function registerPluginUpdater(ctx, options) {
    const host = ctx;
    let installing = false;
    return host.webServer.register({
        kind: 'exact', path: options.endpoint,
        handler: async (request, response) => {
            try {
                const target = runtime(host);
                if (request.method === 'GET' || request.method === 'HEAD') {
                    const payload = await status(options, target);
                    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(payload));
                    return;
                }
                if (request.method !== 'POST') {
                    response.writeHead(405, { allow: 'GET, HEAD, POST' });
                    response.end();
                    return;
                }
                if (!isTrustedUpdateRequest(request)) {
                    json(response, 403, { error: '已拒绝非本机同源更新请求。' });
                    return;
                }
                if (installing) {
                    json(response, 409, { error: '当前插件正在更新，请稍候。' });
                    return;
                }
                const before = await status(options, target);
                if (before.latestVersion === undefined) {
                    json(response, 503, { error: '暂时无法获取最新版本。' });
                    return;
                }
                if (!before.updateAvailable) {
                    json(response, 200, before);
                    return;
                }
                installing = true;
                try {
                    await install(target, `${options.packageName}@${before.latestVersion}`);
                }
                finally {
                    installing = false;
                }
                const notifyParent = shouldNotifyParent(target);
                const autoReload = target.desktopPnpm !== undefined || notifyParent;
                json(response, 200, { ...before, updatedVersion: before.latestVersion, restartRequired: true, autoReload, ...(target.officialDesktop ? { restartDesktop: true } : {}) });
                if (notifyParent)
                    setTimeout(() => { process.send?.(PLUGIN_UPDATE_IPC); }, 150).unref?.();
            }
            catch (error) {
                ctx.logger.warn(`plugin updater failed: ${String(error)}`);
                json(response, 503, { error: publicError(error) });
            }
        },
    });
}
