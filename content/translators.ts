/* eslint-disable no-case-declarations, @typescript-eslint/no-unsafe-return */

Components.utils.import('resource://gre/modules/Services.jsm')

declare class ChromeWorker extends Worker { }

Components.utils.import('resource://zotero/config.js')
declare const ZOTERO_CONFIG: any

import { clone } from './clone'
import { Deferred } from './deferred'
import type { Translators as Translator } from '../typings/translators'
import { Preference } from './prefs'
import { schema, Preferences } from '../gen/preferences/meta'
import { Serializer } from './serializer'
import { log } from './logger'
import { DB as Cache } from './db/cache'
import { DB } from './db/main'
import { flash } from './flash'
import { $and } from './db/loki'
import { Events } from './events'
import { Pinger } from './ping'
import Puqeue from 'puqeue'
import { is7 } from './client'
import { orchestrator } from './orchestrator'
import type { Reason } from './bootstrap'

class Queue extends Puqeue {
  get queued() {
    return this._queue.length
  }
}

import * as translatorMetadata from '../gen/translators.json'

import * as l10n from './l10n'

type ExportScope = { type: 'items', items: any[] } | { type: 'library', id: number } | { type: 'collection', collection: any }
export type ExportJob = {
  translatorID: string
  displayOptions: Record<string, boolean>
  scope: ExportScope
  autoExport?: number
  preferences?: Partial<Preferences>
  path?: string
  started?: number
  canceled?: boolean
  translate?: any
}

// export singleton: https://k94n.com/es6-modules-single-instance-pattern
export const Translators = new class { // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public byId: Record<string, Translator.Header>
  public byName: Record<string, Translator.Header>
  public byLabel: Record<string, Translator.Header>
  public itemType: { note: number, attachment: number, annotation: number }
  public queue = new Queue
  public worker: ChromeWorker

  public ready = new Deferred<boolean>()

  constructor() {
    Object.assign(this, translatorMetadata)

    orchestrator.add('translators', {
      description: 'translators',
      needs: ['database'],
      startup: async () => {
        await this.start()

        this.itemType = {
          note: Zotero.ItemTypes.getID('note'),
          attachment: Zotero.ItemTypes.getID('attachment'),
          annotation: Zotero.ItemTypes.getID('annotation') || 'NULL',
        }

        // cleanup old translators
        this.uninstall('Better BibTeX Quick Copy')
        this.uninstall('\u672B BetterBibTeX JSON (for debugging)')
        this.uninstall('BetterBibTeX JSON (for debugging)')

        this.lateInit().catch(err => {
          log.debug('translators startup failure', err)
        })
      },
      shutdown: async (reason: Reason) => {
        switch (reason) {
          case 'ADDON_DISABLE':
          case 'ADDON_UNINSTALL':
            break
          default:
            return
        }

        const quickCopy = Zotero.Prefs.get('export.quickCopy.setting')
        for (const [label, metadata] of (Object.entries(Translators.byName) )) {
          if (quickCopy === `export=${metadata.translatorID}`) Zotero.Prefs.clear('export.quickCopy.setting')

          try {
            Translators.uninstall(label)
          }
          catch (error) {}
        }

        await Zotero.Translators.reinit()
      },
    })
  }

  private async lateInit() {
    await Zotero.Translators.init()

    const reinit: { header: Translator.Header, code: string }[] = []
    let header: Translator.Header
    let code: string
    // fetch from resource because that has the hash
    const headers: Translator.Header[] = Object.keys(this.byName)
      .map(name => JSON.parse(Zotero.File.getContentsFromURL(`chrome://zotero-better-bibtex/content/resource/${name}.json`)))
    for (header of headers) {
      // workaround for mem limitations on Windows
      if (!is7 && typeof header.displayOptions?.worker === 'boolean') header.displayOptions.worker = !!Zotero.isWin
      if (code = await this.install(header)) reinit.push({ header, code })
    }

    if (reinit.length) {
      await Zotero.Translators.reinit()

      for ({ header, code } of reinit) {
        if (Zotero.Translators.getCodeForTranslator) {
          const translator = Zotero.Translators.get(header.translatorID)
          translator.cacheCode = true
          await Zotero.Translators.getCodeForTranslator(translator)
        }
        else {
          new Zotero.Translator({...header, cacheCode: true, code })
        }
      }
    }

    this.ready.resolve(true)
  }

  public getTranslatorId(name: string): string {
    Zotero.debug(`getTranslatorId: resolving ${JSON.stringify(name)}`)
    const name_lc = name.toLowerCase().replace(/ /g, '')

    // shortcuts
    switch (name_lc) {
      case 'json':
        return Translators.byLabel.BetterCSLJSON.translatorID
      case 'yaml':
        return Translators.byLabel.BetterCSLYAML.translatorID
      case 'jzon':
        return Translators.byLabel.BetterBibTeXJSON.translatorID
      case 'bib':
      case 'biblatex':
        return Translators.byLabel.BetterBibLaTeX.translatorID
      case 'bibtex':
        return Translators.byLabel.BetterBibTeX.translatorID
    }

    for (const [id, translator] of (Object.entries(this.byId))) {
      if (name_lc === translator.label.toLowerCase().replace(/ /g, '') && ['yaml', 'json', 'bib'].includes(translator.target)) return id
    }

    if (typeof name !== 'string' || !name.match(/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}?$/)) {
      Zotero.debug(`getTranslatorId: ${JSON.stringify(name)} is not a GUID`)
      throw new Error(`getTranslatorId: ${JSON.stringify(name)} is not a GUID`)
    }

    return name
  }

  public async importString(str) {
    await this.ready
    const translation = new Zotero.Translate.Import()
    translation.setString(str)

    const zp = Zotero.getActiveZoteroPane()

    if (!zp.collectionsView.editable) {
      await zp.collectionsView.selectLibrary()
    }

    const translators = await translation.getTranslators()

    if (!translators.length) throw new Error('No translators found')

    const libraryID = zp.getSelectedLibraryID()
    await zp.collectionsView.selectLibrary(libraryID)

    translation.setTranslator(translators[0])

    await translation.translate({ libraryID })

    return translation.newItems
  }

  private async start() { // eslint-disable-line @typescript-eslint/require-await
    if (this.worker) return

    try {
      const environment = Object.entries({
        version: Zotero.version,
        platform: Preference.platform,
        locale: Zotero.locale,
        clientName: Zotero.clientName,
        is7,
      }).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')

      this.worker = new ChromeWorker(`chrome://zotero-better-bibtex/content/worker/zotero.js?${environment}`)

      // post dynamically to fix #2485
      this.worker.postMessage({
        kind: 'initialize',
        CSL_MAPPINGS: Object.entries(Zotero.Schema).reduce((acc, [k, v]) => { if (k.startsWith('CSL')) acc[k] = v; return acc}, {}),
      })
    }
    catch (err) {
      log.error('translate: worker not acquired', err)
      if (Preference.testing) throw err

      flash(
        'Failed to start background export',
        `Could not start background export (${err.message}). Background exports have been disabled until restart -- report this as a bug at the Better BibTeX github project`,
        15
      )
      this.worker = null
    }
  }

  public async queueJob(job: ExportJob) {
    await this.start()
    return this.queue.add(() => this.exportItemsByQueuedWorker(job))
  }

  private async exportItemsByQueuedWorker(job: ExportJob) {
    if (job.path && job.canceled) return ''
    await Zotero.BetterBibTeX.ready
    if (job.path && job.canceled) return ''

    const displayOptions = {
      ...this.displayOptions(job.translatorID, job.displayOptions),
      exportPath: job.path || undefined,
      exportDir: job.path ? OS.Path.dirname(job.path) : undefined,
    }

    const translator = this.byId[job.translatorID]

    const start = Date.now()

    const preferences = job.preferences || {}

    const cache = Preference.cache && !(
      // when exporting file data you get relative paths, when not, you get absolute paths, only one version can go into the cache
      displayOptions.exportFileData

      // jabref 4 stores collection info inside the entry, and collection info depends on which part of your library you're exporting
      || (translator.label.includes('TeX') && preferences.jabrefFormat >= 4)

      // relative file paths are going to be different based on the file being exported to
      || preferences.relativeFilePaths
    ) && Cache.getCollection(translator.label)

    const result = new Deferred<string>

    const config: Translator.Worker.Job = {
      preferences: { ...Preference.all, ...preferences },
      options: displayOptions,
      data: {
        items: [],
        collections: [],
        cache: {},
      },
      autoExport: job.autoExport,

      translator: translator.label,
      output: job.path || '',
      debugEnabled: !!Zotero.Debug.enabled,
    }

    let items: any[] = []
    this.worker.onmessage = (e: { data: Translator.Worker.Message }) => {
      switch (e.data?.kind) {
        case 'error':
          log.status({error: true}, 'QBW failed:', Date.now() - start, e.data)
          job.translate?._runHandler('error', e.data) // eslint-disable-line no-underscore-dangle
          result.reject(new Error(e.data.message))
          break

        case 'debug':
          // this is pre-formatted
          Zotero.debug(e.data.message)
          break

        case 'item':
          job.translate?._runHandler('itemDone', items[e.data.item]) // eslint-disable-line no-underscore-dangle
          break

        case 'done':
          void Events.emit('export-progress', { pct: 100, message: translator.label, ae: job.autoExport })
          result.resolve(typeof e.data.output === 'boolean' ? '' : e.data.output)
          break

        case 'cache':
          let { itemID, entry, metadata } = e.data
          if (!metadata) metadata = {}
          Cache.store(translator.label, itemID, config.options, config.preferences, entry, metadata)
          break

        case 'progress':
          void Events.emit('export-progress', { pct: e.data.percent, message: e.data.translator, ae: e.data.autoExport })
          break

        default:
          if (JSON.stringify(e) !== '{"isTrusted":true}') { // why are we getting this?
            log.status({error: true}, 'unexpected message from worker', e)
          }
          break
      }
    }

    this.worker.onerror = e => {
      log.status({error: true}, 'QBW: failed:', Date.now() - start, 'message:', e)
      job.translate?._runHandler('error', e) // eslint-disable-line no-underscore-dangle
      result.reject(new Error(e.message))
    }

    const scope = this.exportScope(job.scope)
    let collections: any[] = []
    switch (scope.type) {
      case 'library':
        items = await Zotero.Items.getAll(scope.id, true)
        collections = Zotero.Collections.getByLibrary(scope.id) // , true)
        break

      case 'items':
        items = scope.items
        break

      case 'collection':
        collections = Zotero.Collections.getByParent(scope.collection.id, true)
        const items_with_duplicates = new Set(scope.collection.getChildItems())
        for (const collection of collections) {
          for (const item of collection.getChildItems()) {
            items_with_duplicates.add(item) // sure hope getChildItems doesn't return a new object?!
          }
        }
        items = Array.from(items_with_duplicates.values())
        break

      default:
        throw new Error(`Unexpected scope: ${Object.keys(scope)}`)
    }
    if (job.path && job.canceled) return ''

    items = items.filter(item => !item.isAnnotation?.())

    let worked = Date.now()
    const prepare = new Pinger({
      total: items.length,
      callback: pct => {
        let preparing = `${l10n.localize('better-bibtex_preferences_auto-export_status_preparing')} ${translator.label}`.trim()
        if (this.queue.queued) preparing += ` +${Translators.queue.queued}`
        void Events.emit('export-progress', { pct, message: preparing, ae: job.autoExport })
      },
    })
    // use a loop instead of map so we can await for beachball protection
    for (const item of items) {
      config.data.items.push(Serializer.fast(item))

      // sleep occasionally so the UI gets a breather
      if ((Date.now() - worked) > 100) {
        await Zotero.Promise.delay(0)
        worked = Date.now()
      }

      prepare.update()
    }
    if (job.path && job.canceled) return ''

    if (this.byId[job.translatorID].configOptions?.getCollections) {
      config.data.collections = collections.map(collection => {
        collection = collection.serialize(true)
        collection.id = collection.primary.collectionID
        collection.name = collection.fields.name
        return collection
      })
    }

    // pre-fetch cache
    if (cache) {
      const selector = schema.translator[translator.label]?.cache ? Cache.selector(translator.label, config.options, config.preferences) : null
      const query = {...selector, itemID: { $in: config.data.items.map(item => item.itemID) }}

      // not safe in async!
      const cloneObjects = cache.cloneObjects
      // uncloned is safe because it gets serialized in the transfer
      cache.cloneObjects = false
      config.data.cache = cache.find($and(query)).reduce((acc, cached) => {
        // direct-DB access for speed...
        cached.meta.updated = (new Date).getTime() // touches the cache object so it isn't reaped too early
        acc[cached.itemID] = cached
        return acc
      }, {})
      cache.cloneObjects = cloneObjects
      cache.dirty = true
    }

    prepare.done()

    log.debug('starting tranlation with', { items: config.data.items.length, cache: Object.keys(config.data.cache).length })
    const config: Translator.Worker.Job = {
      preferences: { ...Preference.all, ...preferences },
      options: displayOptions,
      data: {
        items: [],
        collections: [],
        cache: {},
      },
    const enc = new TextEncoder()
    // stringify gets around 'object could not be cloned', and arraybuffers can be passed zero-copy. win-win
    const abconfig = enc.encode(JSON.stringify(config)).buffer

    this.worker.postMessage({ kind: 'start', config: abconfig }, [ abconfig ])

    return result
  }

  public displayOptions(translatorID: string, displayOptions: any): any {
    displayOptions = clone(displayOptions || this.byId[translatorID]?.displayOptions || {})
    const defaults = this.byId[translatorID]?.displayOptions || {}
    for (const [k, v] of Object.entries(defaults)) {
      if (typeof displayOptions[k] === 'undefined') displayOptions[k] = v
    }
    return displayOptions
  }

  // public async exportItems(translatorID: string, displayOptions: any, scope: ExportScope, path: string = null): Promise<string> {
  public async exportItems(job: ExportJob): Promise<string> {
    await Zotero.BetterBibTeX.ready
    await this.ready

    const displayOptions = this.displayOptions(job.translatorID, job.displayOptions)

    const start = Date.now()

    const result = new Deferred<string>
    const translation = new Zotero.Translate.Export()

    const scope = this.exportScope(job.scope)

    switch (scope.type) {
      case 'library':
        translation.setLibraryID(scope.id)
        break

      case 'items':
        translation.setItems(scope.items)
        break

      case 'collection':
        translation.setCollection(scope.collection)
        break

      default:
        throw new Error(`Unexpected scope: ${Object.keys(scope)}`)
    }

    translation.setTranslator(job.translatorID)
    if (Object.keys(displayOptions).length !== 0) translation.setDisplayOptions(displayOptions)

    if (job.path) {
      let file = null

      try {
        file = Zotero.File.pathToFile(job.path)
        // path could exist but not be a regular file
        if (file.exists() && !file.isFile()) file = null
      }
      catch (err) {
        // or Zotero.File.pathToFile could have thrown an error
        log.error('Translators.exportItems:', err)
        file = null
      }
      if (!file) {
        result.reject(new Error(l10n.localize('better-bibtex_translate_error_target_not_a_file', { path: job.path })))
        return result
      }

      // the parent directory could have been removed
      if (!file.parent || !file.parent.exists()) {
        result.reject(new Error(l10n.localize('better-bibtex_translate_error_target_no_parent', { path: job.path })))
        return result
      }

      translation.setLocation(file)
    }

    translation.setHandler('done', (obj, success) => {
      if (success) {
        result.resolve(obj ? obj.string : undefined)
      }
      else {
        log.error('error: Translators.exportItems failed in', { time: Date.now() - start, ...job, translate: undefined })
        result.reject(new Error('translation failed'))
      }
    })

    translation.translate()

    return result
  }

  public uninstall(label) {
    try {
      const destFile = Zotero.getTranslatorsDirectory()
      destFile.append(`${label}.js`)
      if (destFile.exists()) {
        destFile.remove(false)
        return true
      }
    }
    catch (err) {
      log.error(`Translators.uninstall: failed to remove ${label}:`, err)
      return true
    }

    return false
  }

  public async install(header: Translator.Header): Promise<string> {
    const installed = Zotero.Translators.get(header.translatorID) || null
    if (installed?.configOptions?.hash === header.configOptions.hash) return ''

    const code = [
      `ZOTERO_CONFIG = ${JSON.stringify(ZOTERO_CONFIG)}`,
      Zotero.File.getContentsFromURL(`chrome://zotero-better-bibtex/content/resource/${header.label}.js`),
    ].join('\n')

    if (schema.translator[header.label]?.cache) Cache.getCollection(header.label).removeDataOnly()

    // importing AutoExports would be circular, so access DB directly
    const autoexports = DB.getCollection('autoexport')
    if (autoexports) {
      for (const ae of autoexports.find({ $and: [ { translatorID: { $eq: header.translatorID } }, { status: { $ne: 'scheduled' } } ] })) {
        ae.status = 'scheduled'
        autoexports.update(ae)
      }
    }
    else { // THIS SHOULD NOT BE POSSIBLE! HOW DOES THIS KEEP HAPPENING?
      log.error('translator upgrade error: could not get autoexport collection while installing', header.label)
      flash(
        'Failed to schedule auto-export',
        `Failed to schedule auto-exports after ${installed ? 'upgrade' : 'installation'} of ${header.label}, please report this on the Better BibTeX github project`,
        15
      )
    }

    try {
      await Zotero.Translators.save(header, code)
    }
    catch (err) {
      log.error('Translator.install', header, 'failed:', err)
      this.uninstall(header.label)
      return ''
    }

    return code
  }

  private exportScope(scope: ExportScope): ExportScope {
    if (!scope) scope = { type: 'library', id: Zotero.Libraries.userLibraryID }

    if (scope.type === 'collection' && typeof scope.collection === 'number') {
      return { type: 'collection', collection: Zotero.Collections.get(scope.collection) }
    }

    switch (scope.type) {
      case 'items':
        if (! scope.items?.length ) throw new Error(`invalid scope: ${JSON.stringify(scope)}`)
        break
      case 'collection':
        if (typeof scope.collection?.id !== 'number') throw new Error(`invalid scope: ${JSON.stringify(scope)}`)
        break
      case 'library':
        if (typeof scope.id !== 'number') throw new Error(`invalid scope: ${JSON.stringify(scope)}`)
        break
      default:
        throw new Error(`invalid scope: ${JSON.stringify(scope)}`)
    }

    return scope
  }
}
