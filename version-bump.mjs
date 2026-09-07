/**
 * Keeps manifest.json and versions.json in step with package.json.
 *
 * They drift the moment a version is bumped by hand, and Obsidian reads the
 * manifest while the release tag reads package.json — so a mismatch ships a
 * plugin that reports the wrong version to the user and fails review.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const target = process.env.npm_package_version;
if (!target) throw new Error('run via npm version, so npm_package_version is set');

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = target;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');

const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[target] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');
console.log(`manifest + versions set to ${target} (min app ${minAppVersion})`);
