'use strict';

import path from 'node:path';
const eejs = require('../../eejs')
import fs from 'node:fs';
const fsp = fs.promises;
const toolbar = require('../../utils/toolbar');
const hooks = require('../../../static/js/pluginfw/hooks');
import settings, {getEpVersion} from '../../utils/Settings';
import util from 'node:util';
const webaccess = require('./webaccess');
import readOnlyManager from '../../db/ReadOnlyManager';
const plugins = require('../../../static/js/pluginfw/plugin_defs');
const padManager = require('../../db/PadManager');
const authorManager = require('../../db/AuthorManager');
import {deserializeOps, unpack} from '../../../static/js/Changeset';
import {Builder} from '../../../static/js/Builder';

import {build, buildSync} from 'esbuild'
import {ArgsExpressType} from "../../types/ArgsExpressType";
import prometheus from "../../prometheus";

let ioI: { sockets: { sockets: any[]; }; } | null = null


exports.socketio = (hookName: string, {io}: any) => {
  ioI = io
}


exports.expressPreSession = async (hookName:string, {app}:ArgsExpressType) => {
  // This endpoint is intended to conform to:
  // https://www.ietf.org/archive/id/draft-inadarei-api-health-check-06.html
  app.get('/health', (req:any, res:any) => {
    res.set('Content-Type', 'application/health+json');
    res.json({
      status: 'pass',
      releaseId: getEpVersion(),
    });
  });

  if (settings.enableMetrics) {
    app.get('/stats', (req:any, res:any) => {
      res.json(require('../../stats').toJSON());
    });

    app.get('/stats/prometheus', async (req, res) => {
      const metrics = await prometheus()
      res.setHeader('Content-Type', metrics.contentType)
      res.send(await metrics.metrics())
    })
  }


  app.get('/javascript', (req:any, res:any) => {
    res.send(eejs.require('ep_etherpad-lite/templates/javascript.html', {req}));
  });

  app.get('/robots.txt', (req:any, res:any) => {
    if (!settings.skinName) {
      // if no skin is set, send the default robots.txt
      return res.sendFile(path.join(settings.root, 'src', 'static', 'robots.txt'));
    }
    let filePath =
      path.join(settings.root, 'src', 'static', 'skins', settings.skinName, 'robots.txt');
    res.sendFile(filePath, (err:any) => {
      // there is no custom robots.txt, send the default robots.txt which dissallows all
      if (err) {
        filePath = path.join(settings.root, 'src', 'static', 'robots.txt');
        res.sendFile(filePath);
      }
    });
  });

  app.get('/favicon.ico', (req:any, res:any, next:Function) => {
    (async () => {
      /*
        If this is a url we simply redirect to that one.
       */
      if (settings.favicon && settings.favicon.startsWith('http')) {
        res.redirect(settings.favicon);
        res.send();
        return;
      }


      const fns = [
        ...(settings.favicon ? [path.resolve(settings.root, settings.favicon)] : []),
        settings.skinName && path.join(settings.root, 'src', 'static', 'skins', settings.skinName, 'favicon.ico'),
        path.join(settings.root, 'src', 'static', 'favicon.ico'),
      ].filter(f=>f != null);
      for (const fn of fns) {
        try {
          await fsp.access(fn, fs.constants.R_OK);
        } catch (err) {
          continue;
        }
        res.setHeader('Cache-Control', `public, max-age=${settings.maxAge}`);
        await util.promisify(res.sendFile.bind(res))(fn);
        return;
      }
      next();
    })().catch((err) => next(err || new Error(err)));
  });
};



const convertTypescript = (content: string) => {
  const outputRaw = buildSync({
    stdin: {
      contents: content,
      resolveDir: path.join(settings.root, 'var','js'),
      loader: 'js'
    },
    alias:{
      "ep_etherpad-lite/static/js/browser": 'ep_etherpad-lite/static/js/vendors/browser',
      "ep_etherpad-lite/static/js/nice-select": 'ep_etherpad-lite/static/js/vendors/nice-select'
    },
    bundle: true, // Bundle the files together
    minify: process.env.NODE_ENV === "production", // Minify the output
    sourcemap: !(process.env.NODE_ENV === "production"), // Generate source maps
    sourceRoot: settings.root+"/src/static/js/",
    target: ['es2020'], // Target ECMAScript version
    metafile: true,
    write: false, // Do not write to file system,
  })
  const output = outputRaw.outputFiles[0].text

  return  {
    output,
    hash: outputRaw.outputFiles[0].hash.replaceAll('/','2').replaceAll("+",'5').replaceAll("^","7")
  }
}

const MIN_ADDITION_CHARS = 100;
/** Number of highlight colors for large additions (cycles if more revisions). */
const LARGE_ADDITION_PALETTE_SIZE = 10;

/**
 * Returns the number of characters inserted by a changeset (sum of lengths of all '+' ops).
 */
const getInsertionSize = (changeset: string): number => {
  const {ops} = unpack(changeset);
  let total = 0;
  for (const op of deserializeOps(ops)) {
    if (op.opcode === '+') total += op.chars;
  }
  return total;
};

/**
 * Returns text inserted by each '+' op in the changeset (from charBank in order).
 */
const getInsertedStringsFromChangeset = (changeset: string): string[] => {
  const {ops, charBank} = unpack(changeset);
  const result: string[] = [];
  let bankIndex = 0;
  for (const op of deserializeOps(ops)) {
    if (op.opcode === '+') {
      const segment = charBank.slice(bankIndex, bankIndex + op.chars);
      bankIndex += op.chars;
      result.push(segment);
    }
  }
  return result;
};

/**
 * Returns text removed by each '-' op in the changeset (from oldText in order).
 */
const getDeletedStringsFromChangeset = (changeset: string, oldText: string): string[] => {
  const {ops, oldLen: csOldLen} = unpack(changeset);
  if (oldText.length !== csOldLen) return [];
  const result: string[] = [];
  let strPos = 0;
  for (const op of deserializeOps(ops)) {
    if (op.opcode === '-') {
      result.push(oldText.slice(strPos, strPos + op.chars));
      strPos += op.chars;
    } else if (op.opcode === '=') {
      strPos += op.chars;
    }
    // '+' does not consume oldText
  }
  return result;
};

/** Item for the review page "large additions" list (rev, author id, authorName for display, time, addedChars). */
type ReviewItem = { rev: number; author: string; authorName: string; timestamp: number; addedChars: number; formattedTime: string };

/** Word-count and editing-time contribution for the review page author stats. */
type AuthorWordStat = { authorName: string; wordCount: number; percentage: number; editingTimeFormatted: string };

const countWords = (text: string): number =>
  text.trim().split(/\s+/).filter((s) => s.length > 0).length;

/** Revisions within this many ms are considered one continuous editing session. */
const EDITING_SESSION_GAP_MS = 5 * 60 * 1000;

/**
 * Sums editing time from revision timestamps: sorts by time, groups into sessions
 * where consecutive revisions are < EDITING_SESSION_GAP_MS apart, and sums
 * (session end - session start) for each session.
 */
const computeEditingTimeMs = (timestamps: number[]): number => {
  if (timestamps.length === 0) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let total = 0;
  let sessionStart = sorted[0];
  let sessionEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sessionEnd <= EDITING_SESSION_GAP_MS) {
      sessionEnd = sorted[i];
    } else {
      total += sessionEnd - sessionStart;
      sessionStart = sorted[i];
      sessionEnd = sorted[i];
    }
  }
  total += sessionEnd - sessionStart;
  return total;
};

const formatEditingTime = (ms: number): string => {
  if (ms < 0) return '0m';
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const h = Math.floor(min / 60);
  if (h > 0) return `${h}h ${min % 60}m`;
  if (min > 0) return `${min}m`;
  return `${sec}s`;
};

const formatReviewTime = (ts: number): string => {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
};

/** [start, end) character ranges in the pad text. */
type TextRange = [number, number];

const mergeRanges = (ranges: TextRange[]): TextRange[] => {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: TextRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
};

/**
 * Renders the review page: creates/updates pad "${padId}_reviewed" with the
 * current pad's atext/apool (final version), highlights text from large
 * additions that still appears, then serves review.html with an iframe
 * pointing at that pad.
 */
const handleReviewPage = (entrypoint: string) => async (req: any, res: any, next: Function) => {
  const padId = decodeURIComponent(req.params.pad);
  try {
    const exists = await padManager.doesPadExist(padId);
    if (!exists) {
      res.status(404).send('Pad not found');
      return;
    }
    const pad = await padManager.getPad(padId);
    const reviewedPadId = `${padId}_reviewed`;
    await pad.copyPadWithoutHistory(reviewedPadId, true, '');
    const reviewedPad = await padManager.getPad(reviewedPadId);
    const finalText = reviewedPad.text();

    /** Ranges per revision index (0-based index into largeAdditionItems). */
    const rangesPerRev: TextRange[][] = [];
    const largeAdditionItems: ReviewItem[] = [];
    const head = pad.getHeadRevisionNumber();

    // Aggregate word count and revision timestamps per author across all revisions for stats.
    const wordsByAuthorId = new Map<string, number>();
    const timestampsByAuthorId = new Map<string, number[]>();
    for (let rev = 1; rev <= head; rev++) {
      const revData = await pad.getRevision(rev);
      const author = revData.meta?.author ?? '';
      const timestamp = revData.meta?.timestamp ?? 0;
      const inserted = getInsertedStringsFromChangeset(revData.changeset).join('');
      const words = countWords(inserted);
      if (words > 0) {
        wordsByAuthorId.set(author, (wordsByAuthorId.get(author) ?? 0) + words);
      }
      if (timestamp > 0) {
        const arr = timestampsByAuthorId.get(author);
        if (arr) arr.push(timestamp);
        else timestampsByAuthorId.set(author, [timestamp]);
      }
    }
    const editingTimeByAuthorId = new Map<string, number>();
    for (const [authorId, timestamps] of timestampsByAuthorId) {
      editingTimeByAuthorId.set(authorId, computeEditingTimeMs(timestamps));
    }
    const totalWords = [...wordsByAuthorId.values()].reduce((a, b) => a + b, 0);
    const authorStats: AuthorWordStat[] = [];
    if (totalWords > 0) {
      const authorIds = [...wordsByAuthorId.keys()];
      const names = await Promise.all(authorIds.map((id) =>
        id ? authorManager.getAuthorName(id) : Promise.resolve(null)));
      const wordsByAuthorName = new Map<string, number>();
      const editingTimeByAuthorName = new Map<string, number>();
      for (let i = 0; i < authorIds.length; i++) {
        const authorName = names[i] || 'anonymous';
        const wordCount = wordsByAuthorId.get(authorIds[i]) ?? 0;
        wordsByAuthorName.set(authorName, (wordsByAuthorName.get(authorName) ?? 0) + wordCount);
        const editingMs = editingTimeByAuthorId.get(authorIds[i]) ?? 0;
        editingTimeByAuthorName.set(authorName, (editingTimeByAuthorName.get(authorName) ?? 0) + editingMs);
      }
      for (const [authorName, wordCount] of wordsByAuthorName) {
        const editingMs = editingTimeByAuthorName.get(authorName) ?? 0;
        authorStats.push({
          authorName,
          wordCount,
          percentage: Math.round((wordCount / totalWords) * 1000) / 10,
          editingTimeFormatted: formatEditingTime(editingMs),
        });
      }
      authorStats.sort((a, b) => b.wordCount - a.wordCount);
    }

    for (let rev = 1; rev <= head; rev++) {
      const revData = await pad.getRevision(rev);
      const changeset = revData.changeset;
      const addedChars = getInsertionSize(changeset);
      if (addedChars <= MIN_ADDITION_CHARS) continue;
      const insertedBlocks = getInsertedStringsFromChangeset(changeset);

      let skipAsReinsertion = false;
      const startPrev = Math.max(1, rev - 10);
      for (let prevRev = rev - 1; prevRev >= startPrev; prevRev--) {
        const prevData = await pad.getRevision(prevRev);
        const textBeforePrev = (await pad.getInternalRevisionAText(prevRev - 1)).text;
        const deletedBlocks = getDeletedStringsFromChangeset(prevData.changeset, textBeforePrev);
        const allInsertedWereDeleted = insertedBlocks.every((block) => {
          if (block.trim().length === 0) return true;
          return deletedBlocks.some((d) => d.includes(block));
        });
        if (allInsertedWereDeleted) {
          skipAsReinsertion = true;
          break;
        }
      }
      if (skipAsReinsertion) continue; // skip: this addition was re-adding recently deleted content

      const textBeforeRev = (await pad.getInternalRevisionAText(rev - 1)).text;
      const allBlocksAlreadyExist = insertedBlocks.every((block) => {
        if (block.trim().length === 0) return true;
        const substrings = block.split('\n').filter((s) => s.trim().length > 0);
        return substrings.every((needle) => textBeforeRev.includes(needle));
      });
      if (allBlocksAlreadyExist) continue;
      const timestamp = revData.meta?.timestamp ?? 0;
      const revRanges: TextRange[] = [];
      for (const block of insertedBlocks) {
        if (block.trim().length === 0) continue;
        const substrings = block.split('\n').filter((s) => s.trim().length > 0);
        for (const needle of substrings) {
          let idx = 0;
          while ((idx = finalText.indexOf(needle, idx)) >= 0) {
            revRanges.push([idx, idx + needle.length]);
            idx += 1;
          }
        }
      }
      const merged = mergeRanges(revRanges).filter(([start, end]) => end - start >= 30);
      if (merged.length === 0) continue;
      rangesPerRev.push(merged);
      largeAdditionItems.push({
        rev,
        author: revData.meta?.author ?? '',
        authorName: '', // resolved below
        timestamp,
        addedChars,
        formattedTime: formatReviewTime(timestamp),
      });
    }

    // Resolve author IDs to display names for the review list.
    await Promise.all(largeAdditionItems.map(async (item) => {
      const name = item.author ? await authorManager.getAuthorName(item.author) : null;
      item.authorName = name || 'anonymous';
    }));

    /** Non-overlapping segments (start, end, colorIndex). Overlaps resolved by lowest colorIndex. */
    const segments: [number, number, number][] = [];
    if (rangesPerRev.length > 0) {
      type Event = { pos: number; type: 'start' | 'end'; revIndex: number };
      const events: Event[] = [];
      for (let revIndex = 0; revIndex < rangesPerRev.length; revIndex++) {
        for (const [start, end] of rangesPerRev[revIndex]) {
          events.push({ pos: start, type: 'start', revIndex });
          events.push({ pos: end, type: 'end', revIndex });
        }
      }
      events.sort((a, b) => a.pos !== b.pos ? a.pos - b.pos : (a.type === 'end' ? -1 : 1) - (b.type === 'end' ? -1 : 1));
      const active = new Set<number>();
      let segmentStart = 0;
      for (const e of events) {
        if (active.size > 0 && e.pos > segmentStart) {
          const revIndex = Math.min(...active);
          segments.push([segmentStart, e.pos, revIndex]);
        }
        segmentStart = e.pos;
        if (e.type === 'start') active.add(e.revIndex);
        else active.delete(e.revIndex);
      }
    }

    if (segments.length > 0) {
      const pool = reviewedPad.apool();
      for (let i = 0; i < LARGE_ADDITION_PALETTE_SIZE; i++) {
        pool.putAttrib(['large_addition', String(i)]);
      }
      const builder = new Builder(finalText.length);
      let pos = 0;
      for (const [start, end, revIndex] of segments) {
        if (start > pos) {
          builder.keepText(finalText.slice(pos, start));
        }
        const colorIndex = revIndex % LARGE_ADDITION_PALETTE_SIZE;
        builder.keepText(finalText.slice(start, end), [['large_addition', String(colorIndex)]], pool);
        pos = end;
      }
      if (pos < finalText.length) {
        builder.keepText(finalText.slice(pos));
      }
      await reviewedPad.appendRevision(builder.toString(), '');
    }

    const readOnlyId = await readOnlyManager.getReadOnlyId(reviewedPadId);
    const backToPadPath = req.path.replace(/\/review\/?$/, '');
    const reviewedPadBase = backToPadPath.replace(/\/[^/]+$/, '') + '/' + encodeURIComponent(readOnlyId);
    const reviewedPadPath = `${reviewedPadBase}?showControls=false&showChat=false&showLineNumbers=false&useMonospaceFont=false&mobile=false`;
    res.send(eejs.require('ep_etherpad-lite/templates/review.html', {
      req,
      entrypoint,
      settings: settings.getPublicSettings(),
      reviewedPadPath,
      backToPadPath,
      largeAdditionItems,
      authorStats,
      padName: padId,
    }));
  } catch (err: any) {
    next(err);
  }
};

const handleLiveReload = async (args: ArgsExpressType, padString: string, timeSliderString: string, indexString: any, reviewString: string) => {
  const chokidar = await import('chokidar')
  const watcher = chokidar.watch(path.join(settings.root, 'src', 'static', 'js'), {});
  let routeHandlers: { [key: string]: Function } = {};

  const setRouteHandler = (path: string, newHandler: Function) => {
    routeHandlers[path] = newHandler;
  };
  args.app.use((req: any, res: any, next: Function) => {
    const pathParts = req.path.split('/');
    if (req.path.startsWith('/p/') && pathParts.length === 3) {
      req.params = { pad: pathParts[2] };
      routeHandlers['/p/:pad'](req, res);
    } else if (req.path.startsWith('/p/') && pathParts.length === 4) {
      req.params = { pad: pathParts[2] };
      const subPage = pathParts[3];
      if (subPage === 'timeslider' && routeHandlers['/p/:pad/timeslider']) {
        routeHandlers['/p/:pad/timeslider'](req, res);
      } else if (subPage === 'review' && routeHandlers['/p/:pad/review']) {
        routeHandlers['/p/:pad/review'](req, res);
      } else {
        next();
      }
    } else if (req.path == "/"){
      routeHandlers['/'](req, res);
    } else if (routeHandlers[req.path]) {
      routeHandlers[req.path](req, res);
    } else {
      next();
    }
  });

  function handleUpdate() {

    convertTypescriptWatched(indexString, (output, hash) => {
      setRouteHandler('/watch/index', (req: any, res: any) => {
        res.header('Content-Type', 'application/javascript');
        res.send(output)
      })
    const indexTemplate = settings.skinName === 'originis'
      ? 'ep_etherpad-lite/static/skins/originis/home.html'
      : 'ep_etherpad-lite/templates/index.html';
    const reviewportalTemplate = 'ep_etherpad-lite/static/skins/originis/reviewportal.html';
    setRouteHandler('/', (req: any, res: any) => {
        res.send(eejs.require(indexTemplate, {req, entrypoint: '/watch/index?hash=' + hash, settings}));
      })
    setRouteHandler('/reviewportal', (req: any, res: any) => {
        res.send(eejs.require(reviewportalTemplate, {req, entrypoint: '/watch/index?hash=' + hash, settings}));
      })
    })

    convertTypescriptWatched(padString, (output, hash) => {
      console.log("New pad hash is", hash)
      setRouteHandler('/watch/pad', (req: any, res: any) => {
        res.header('Content-Type', 'application/javascript');
        res.send(output)
      })




      setRouteHandler("/p/:pad", (req: any, res: any, next: Function) => {
        // The below might break for pads being rewritten
        const isReadOnly = !webaccess.userCanModify(req.params.pad, req);

        hooks.callAll('padInitToolbar', {
          toolbar,
          isReadOnly
        });

        const content = eejs.require('ep_etherpad-lite/templates/pad.html', {
          req,
          toolbar,
          isReadOnly,
          entrypoint: '/watch/pad?hash=' + hash,
          settings: settings.getPublicSettings()
        })
        res.send(content);
      })
      ioI!.sockets.sockets.forEach(socket => socket.emit('liveupdate'))
    })
    convertTypescriptWatched(timeSliderString, (output, hash) => {
      // serve timeslider.html under /p/$padname/timeslider
      console.log("New timeslider hash is", hash)

      setRouteHandler('/watch/timeslider', (req: any, res: any) => {
        res.header('Content-Type', 'application/javascript');
        res.send(output)
      })

      setRouteHandler("/p/:pad/timeslider", (req: any, res: any, next: Function) => {
        console.log("Reloading pad")
        // The below might break for pads being rewritten
        const isReadOnly = !webaccess.userCanModify(req.params.pad, req);

        hooks.callAll('padInitToolbar', {
          toolbar,
          isReadOnly
        });

        const content = eejs.require('ep_etherpad-lite/templates/timeslider.html', {
          req,
          toolbar,
          isReadOnly,
          entrypoint: '/watch/timeslider?hash=' + hash,
          settings: settings.getPublicSettings()
        })
        res.send(content);
      })
    })
    convertTypescriptWatched(reviewString, (output, hash) => {
      setRouteHandler('/watch/review', (req: any, res: any) => {
        res.header('Content-Type', 'application/javascript');
        res.send(output)
      })
      setRouteHandler('/p/:pad/review', handleReviewPage('/watch/review?hash=' + hash));
    })
  }

  watcher.on('change', path => {
    console.log(`File ${path} has been changed`);
    handleUpdate();
  });
  handleUpdate()
}

const convertTypescriptWatched = (content: string, cb: (output:string, hash: string)=>void) => {
  build({
    stdin: {
      contents: content,
      resolveDir: path.join(settings.root, 'var','js'),
      loader: 'js'
    },
    alias:{
      "ep_etherpad-lite/static/js/browser": 'ep_etherpad-lite/static/js/vendors/browser',
      "ep_etherpad-lite/static/js/nice-select": 'ep_etherpad-lite/static/js/vendors/nice-select'
    },
    bundle: true, // Bundle the files together
    minify: process.env.NODE_ENV === "production", // Minify the output
    sourcemap: !(process.env.NODE_ENV === "production"), // Generate source maps
    sourceRoot: settings.root+"/src/static/js/",
    target: ['es2020'], // Target ECMAScript version
    metafile: true,
    write: false, // Do not write to file system,
  }).then((outputRaw) => {
    cb(
      outputRaw.outputFiles[0].text,
      outputRaw.outputFiles[0].hash.replaceAll('/','2').replaceAll("+",'5').replaceAll("^","7")
    )
  })
}

exports.expressCreateServer = async (_hookName: string, args: ArgsExpressType, cb: Function) => {
  const padString =   eejs.require('ep_etherpad-lite/templates/padBootstrap.js', {
    pluginModules: (() => {
      const pluginModules = new Set();
      for (const part of plugins.parts) {
        for (const [, hookFnName] of Object.entries(part.client_hooks || {})) {
          // @ts-ignore
          pluginModules.add(hookFnName.split(':')[0]);
        }
      }
      return [...pluginModules];
    })(),
    settings,
  })

  const indexString = eejs.require('ep_etherpad-lite/templates/indexBootstrap.js', {
  })

  const timeSliderString = eejs.require('ep_etherpad-lite/templates/timeSliderBootstrap.js', {
    pluginModules: (() => {
      const pluginModules = new Set();
      for (const part of plugins.parts) {
        for (const [, hookFnName] of Object.entries(part.client_hooks || {})) {
          // @ts-ignore
          pluginModules.add(hookFnName.split(':')[0]);
        }
      }
      return [...pluginModules];
    })(),
    settings,
  })

  const reviewString = eejs.require('ep_etherpad-lite/templates/reviewBootstrap.js', { settings })

  const outdir = path.join(settings.root, 'var','js')
  // Create the outdir if it doesn't exist
  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir);
  }

  let fileNamePad: string
  let fileNameTimeSlider: string
  let fileNameIndex: string
  let fileNameReview: string
  if(process.env.NODE_ENV === "production"){
    const padSliderWrite = convertTypescript(padString)
    const timeSliderWrite = convertTypescript(timeSliderString)
    const indexWrite = convertTypescript(indexString)
    const reviewWrite = convertTypescript(reviewString)

    fileNamePad = `padbootstrap-${padSliderWrite.hash}.min.js`
    fileNameTimeSlider = `timeSliderBootstrap-${timeSliderWrite.hash}.min.js`
    fileNameIndex = `indexBootstrap-${indexWrite.hash}.min.js`
    fileNameReview = `reviewBootstrap-${reviewWrite.hash}.min.js`

    args.app.get("/"+fileNamePad, (_req, res) => {
      res.header('Content-Type', 'application/javascript');
      res.send(padSliderWrite.output)
    })

    args.app.get("/"+fileNameIndex, (_req, res) => {
      res.header('Content-Type', 'application/javascript');
      res.send(indexWrite.output)
    })

    args.app.get("/"+fileNameTimeSlider, (_req, res) => {
      res.header('Content-Type', 'application/javascript');
      res.send(timeSliderWrite.output)
    })

    args.app.get("/"+fileNameReview, (_req, res) => {
      res.header('Content-Type', 'application/javascript');
      res.send(reviewWrite.output)
    })

    // serve index.html or skin landing page under /
    const indexTemplate = settings.skinName === 'originis'
      ? 'ep_etherpad-lite/static/skins/originis/home.html'
      : 'ep_etherpad-lite/templates/index.html';
    args.app.get('/', (req: any, res: any) => {
      res.send(eejs.require(indexTemplate, {req, settings, entrypoint: "./"+fileNameIndex}));
    });

    args.app.get('/reviewportal', (req: any, res: any) => {
      res.send(eejs.require('ep_etherpad-lite/static/skins/originis/reviewportal.html', {req, settings, entrypoint: "./"+fileNameIndex}));
    });

    // serve pad.html under /p
    args.app.get('/p/:pad', (req: any, res: any, next: Function) => {
      // The below might break for pads being rewritten
      const isReadOnly = !webaccess.userCanModify(req.params.pad, req);

      hooks.callAll('padInitToolbar', {
        toolbar,
        isReadOnly
      });

      const content = eejs.require('ep_etherpad-lite/templates/pad.html', {
        req,
        toolbar,
        isReadOnly,
        entrypoint: "../"+fileNamePad,
        settings: settings.getPublicSettings()
      })
      res.send(content);
    });

    // serve timeslider.html under /p/$padname/timeslider
    args.app.get('/p/:pad/timeslider', (req: any, res: any, next: Function) => {
      hooks.callAll('padInitToolbar', {
        toolbar,
      });

      res.send(eejs.require('ep_etherpad-lite/templates/timeslider.html', {
        req,
        toolbar,
        entrypoint: "../../"+fileNameTimeSlider,
        settings: settings.getPublicSettings()
      }));
    });

    args.app.get('/p/:pad/review', handleReviewPage('../../' + fileNameReview));
  } else {
    await handleLiveReload(args, padString, timeSliderString, indexString, reviewString)
  }

  // The client occasionally polls this endpoint to get an updated expiration for the express_sid
  // cookie. This handler must be installed after the express-session middleware.
  args.app.put('/_extendExpressSessionLifetime', (req: any, res: any) => {
    // express-session automatically calls req.session.touch() so we don't need to do it here.
    res.json({status: 'ok'});
  });
};
