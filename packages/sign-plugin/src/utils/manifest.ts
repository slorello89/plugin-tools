import crypto from 'crypto';
import fs from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import axios from 'axios';

const MANIFEST_FILE = 'MANIFEST.txt';

export interface ManifestInfo {
  // time: number;  << filled in by the server
  // keyId: string; << filled in by the server
  // signedByOrg: string; << filled in by the server
  // signedByOrgName: string; << filled in by the server
  signatureType?: string; // filled in by the server if not specified
  rootUrls?: string[]; // for private signatures
  plugin: string;
  version: string;
  files: Record<string, string>;
  signPlugin?: {
    version: string;
  };
}

type RecursiveWalk = AsyncGenerator<string, void | RecursiveWalk>;

async function* walk(dir: string, baseDir: string): RecursiveWalk {
  for await (const d of await fs.opendir(dir)) {
    const entry = path.join(dir, d.name);
    if (d.isDirectory()) {
      yield* await walk(entry, baseDir);
    } else if (d.isFile()) {
      yield path.relative(baseDir, entry);
    } else if (d.isSymbolicLink()) {
      const realPath = await fs.realpath(entry);
      if (!realPath.startsWith(baseDir)) {
        throw new Error(
          `symbolic link ${path.relative(baseDir, entry)} targets a file outside of the base directory: ${baseDir}`
        );
      }
      // if resolved symlink target is a file include it in the manifest
      const stats = await fs.stat(realPath);
      if (stats.isFile()) {
        yield path.relative(baseDir, entry);
      }
    }
  }
}

export async function buildManifest(dir: string): Promise<ManifestInfo> {
  const pluginJson = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), { encoding: 'utf8' }));

  const manifest = {
    plugin: pluginJson.id,
    version: pluginJson.info.version,
    files: {},
  } as ManifestInfo;

  for await (const filePath of await walk(dir, dir)) {
    if (filePath === MANIFEST_FILE) {
      continue;
    }

    // Signing plugins on Windows can create invalid paths with `\\` in the manifest
    // causing `Modified signature` errors in Grafana. Regardless of OS make sure
    // we have a posix compatible path.
    const sanitisedFilePath = filePath.split(path.sep).join(path.posix.sep);

    manifest.files[sanitisedFilePath] = crypto
      .createHash('sha256')
      .update(readFileSync(path.join(dir, filePath)))
      .digest('hex');
  }

  return manifest;
}

export async function signManifest(manifest: ManifestInfo): Promise<string> {
  const GRAFANA_API_KEY = process.env.GRAFANA_API_KEY;
  if (!GRAFANA_API_KEY) {
    throw new Error(
      'You must create a GRAFANA_API_KEY env variable to sign plugins. Please see: https://grafana.com/docs/grafana/latest/developers/plugins/sign-a-plugin/#generate-an-api-key for instructions.'
    );
  }

  const GRAFANA_COM_URL = process.env.GRAFANA_COM_URL || 'https://grafana.com/api';
  const url = GRAFANA_COM_URL + '/plugins/ci/sign';

  try {
    const info = await axios.post(url, manifest, {
      headers: { Authorization: 'Bearer ' + GRAFANA_API_KEY },
    });
    if (info.status !== 200) {
      console.error('Error: ', info);
      throw new Error('Error signing manifest');
    }

    return info.data;
  } catch (err: any) {
    if (err.response?.data?.message) {
      throw new Error('Error signing manifest: ' + err.response.data.message);
    }

    throw new Error('Error signing manifest: ' + err.message);
  }
}

export function saveManifest(dir: string, signedManifest: string) {
  try {
    writeFileSync(path.join(dir, MANIFEST_FILE), signedManifest);
    return true;
  } catch (error) {
    console.error(error);
    throw new Error('Error saving manifest');
  }
}
