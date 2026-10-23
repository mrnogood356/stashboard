import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyFile,
  findEmptyFolders,
  foldersLeftBehind,
  insideAny,
  removeEmptyFolders,
} from './folder-cleanup.util';

describe('empty folder cleanup', () => {
  it('finds and removes only folders with no real files', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lib-'));
    mkdirSync(path.join(root, 'scenes', 'scenes', 'Studio A'), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, 'scenes', 'scenes', 'Studio A', '.DS_Store'),
      '',
    );
    mkdirSync(path.join(root, 'scenes', 'Studio B'), { recursive: true });
    writeFileSync(path.join(root, 'scenes', 'Studio B', 'b.mp4'), 'x');
    mkdirSync(path.join(root, 'Keep me'), { recursive: true });

    const empty = await findEmptyFolders(root, [path.join(root, 'Keep me')]);
    expect(empty.map((folder) => path.relative(root, folder)).sort()).toEqual([
      'scenes/scenes',
      'scenes/scenes/Studio A',
    ]);

    const { removed } = await removeEmptyFolders(empty);
    expect(removed).toHaveLength(2);
    expect(existsSync(path.join(root, 'scenes', 'scenes'))).toBe(false);
    expect(existsSync(path.join(root, 'scenes', 'Studio B', 'b.mp4'))).toBe(
      true,
    );
    expect(existsSync(path.join(root, 'Keep me'))).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it('never removes a folder with a download still in progress', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lib-'));
    mkdirSync(path.join(root, 'downloading'));
    writeFileSync(path.join(root, 'downloading', 'scene.mp4.part'), 'x');
    writeFileSync(path.join(root, 'downloading', 'scene.nfo'), 'x');

    expect(await findEmptyFolders(root)).toEqual([]);
    for (const name of ['a.mkv.part', 'b.!qB', 'c.crdownload', 'd.aria2']) {
      expect(classifyFile(name, 1)).toBe('keep');
    }
  });

  it('leaves a folder alone if a file appeared in it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lib-'));
    mkdirSync(path.join(root, 'x'));
    writeFileSync(path.join(root, 'x', 'new.mp4'), 'x');
    const { removed, kept } = await removeEmptyFolders([path.join(root, 'x')]);
    expect(removed).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  it('lists the folders a moved file left behind, up to the library folder', () => {
    expect(
      foldersLeftBehind('/data/lib/scenes/scenes/S/a.mp4', '/data/lib'),
    ).toEqual([
      '/data/lib/scenes/scenes/S',
      '/data/lib/scenes/scenes',
      '/data/lib/scenes',
    ]);
    expect(foldersLeftBehind('/data/lib/a.mp4', '/data/lib')).toEqual([]);
  });

  it('treats folders with no video as leftovers, but keeps galleries and big files', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lib-'));
    const make = (rel: string, content = 'x') => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    };
    make('Old/Scene A/Scene A.nfo');
    make('Old/Scene A/Scene A-poster.jpg');
    make('Old/Scene A/Scene A.en.srt');
    make('Old/Scene B/b.mkv');
    make('Old/Scene B/b.nfo');
    make('Photos/Set 1/001.jpg');
    make('Archive/set.zip');
    make('Mixed/Parent.nfo');
    make('Mixed/Child/c.mp4');

    const found = (await findEmptyFolders(root))
      .map((folder) => path.relative(root, folder))
      .sort();
    expect(found).toEqual(['Old/Scene A', 'Photos', 'Photos/Set 1']);

    const { removed } = await removeEmptyFolders([
      path.join(root, 'Old/Scene A'),
    ]);
    expect(removed).toHaveLength(1);
    expect(existsSync(path.join(root, 'Old', 'Scene A'))).toBe(false);
    expect(existsSync(path.join(root, 'Old', 'Scene B', 'b.nfo'))).toBe(true);
    expect(existsSync(path.join(root, 'Mixed', 'Parent.nfo'))).toBe(true);
  });

  it('classifies files', () => {
    expect(classifyFile('a.MP4', 10)).toBe('keep');
    expect(classifyFile('a.nfo', 10)).toBe('leftover');
    expect(classifyFile('fanart.jpg', 10)).toBe('leftover');
    expect(classifyFile('IMG_001.jpg', 10)).toBe('image');
    expect(classifyFile('a.zip', 10)).toBe('keep');
    expect(classifyFile('mystery.bin', 60 * 1024 * 1024)).toBe('keep');
    expect(classifyFile('.DS_Store', 10)).toBe('junk');
  });

  it('treats folders with only .nzb, .txt or pictures as leftovers', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lib-'));
    const make = (rel: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), 'x');
    };
    make('Download/scene.nzb');
    make('Download/shot1.jpg');
    make('Download/info.txt');
    make('Gallery/001.jpg');
    make('Gallery/002.jpg');
    const found = (await findEmptyFolders(root))
      .map((folder) => path.relative(root, folder))
      .sort();
    expect(found).toEqual(['Download', 'Gallery']);
    const { removed } = await removeEmptyFolders(
      found.map((folder) => path.join(root, folder)),
    );
    expect(removed).toHaveLength(2);
  });

  it('leaves a kept folder, and everything inside it, out of the clean-up', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lib-'));
    const make = (rel: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), 'x');
    };
    make('Keep/Empty/info.txt');
    make('Other/info.txt');
    const found = (await findEmptyFolders(root, [], [path.join(root, 'Keep')]))
      .map((folder) => path.relative(root, folder))
      .sort();
    expect(found).toEqual(['Other']);
  });

  it('tells a folder inside a kept one from one that only starts the same', () => {
    expect(insideAny('/data/Keep/a', ['/data/Keep/'])).toBe(true);
    expect(insideAny('/data/Keep', ['/data/Keep'])).toBe(true);
    expect(insideAny('/data/Keeper', ['/data/Keep'])).toBe(false);
    expect(insideAny('/data/a', [''])).toBe(false);
  });
});
