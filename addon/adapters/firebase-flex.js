/** @module emberfire-utils */
import { assign } from 'ember-platform';
import { bind, next } from 'ember-runloop';
import { camelize } from 'ember-string';
import { pluralize } from 'ember-inflector';
import Adapter from 'ember-data/adapter';
import RSVP from 'rsvp';
import computed from 'ember-computed';
import getOwner from 'ember-owner/get';
import inject from 'ember-service/inject';

/**
 * @class FirebaseFlex
 * @namespace Adapter
 * @extends DS.Adapter
 */
export default Adapter.extend({
  defaultSerializer: '-firebase-flex',

  /**
   * @type {Ember.Service}
   * @protected
   * @default
   * @readonly
   */
  firebase: inject(),

  /**
   * @type {string}
   * @protected
   * @default
   */
  innerReferencePathName: '_innerReferencePath',

  /**
   * @type {Object}
   * @private
   * @default
   */
  trackedRecords: null,

  /**
   * @type {Object}
   * @private
   * @default
   */
  trackedListeners: {},

  /**
   * @type {Object}
   * @private
   * @default
   */
  trackedQueries: {},

  /**
   * @type {Ember.Service}
   * @protected
   * @default
   * @readonly
   */
  fastboot: computed(function() {
    return getOwner(this).lookup('service:fastboot');
  }),

  /**
   * Adapter hook
   */
  init() {
    this._super(...arguments);

    this.set('trackedRecords', {});
  },

  /**
   * Generates an ID for a record using Firebase push API
   *
   * @return {string} Push ID
   */
  generateIdForRecord() {
    return this.get('firebase').push().key;
  },

  /**
   * Creates a record
   *
   * @param {DS.Store} store
   * @param {DS.Model} type
   * @param {DS.Snapshot} snapshot
   * @return {Promise} Resolves when create record succeeds
   */
  createRecord(store, type, snapshot) {
    return this.updateRecord(store, type, snapshot);
  },

  /**
   * Updates a record
   *
   * @param {DS.Store} store
   * @param {DS.Model} type
   * @param {DS.Snapshot} snapshot
   * @return {Promise} Resolves when update record succeeds
   */
  updateRecord(store, type, snapshot) {
    return new RSVP.Promise(bind(this, (resolve, reject) => {
      const serializedSnapshot = this.serialize(snapshot, {
        innerReferencePathName: this.get('innerReferencePathName'),
      });

      this.get('firebase').update(serializedSnapshot, bind(this, (error) => {
        if (error) {
          reject(new Error(error));
        } else {
          const modelName = type.modelName;
          const id = snapshot.id;
          const path = this.buildPath(modelName, id, snapshot.adapterOptions);
          const ref = this.buildFirebaseReference(path);

          this.listenForRecordChanges(store, modelName, id, ref);
          resolve();
        }
      }));
    }));
  },

  /**
   * Finds a record
   *
   * @param {DS.Store} store
   * @param {DS.Model} type
   * @param {string} id
   * @param {DS.Snapshot} [snapshot={}]
   * @return {Promise} Resolves with the fetched record
   */
  findRecord(store, type, id, snapshot = {}) {
    return new RSVP.Promise(bind(this, (resolve, reject) => {
      const modelName = type.modelName;
      const path = this.buildPath(modelName, id, snapshot.adapterOptions);
      const ref = this.buildFirebaseReference(path);
      const onValue = bind(this, (snapshot) => {
        if (snapshot.exists()) {
          this.listenForRecordChanges(store, modelName, id, ref);
          ref.off('value', onValue);
          resolve(this.mergeSnapshotIdAndValue(snapshot));
        } else {
          reject(new Error(`Record ${id} for type ${modelName} not found`));
        }
      });

      ref.on('value', onValue, bind(this, (error) => {
        reject(new Error(error));
      }));
    }));
  },

  /**
   * Finds all records for a model
   *
   * @param {DS.Store} store
   * @param {DS.Model} type
   * @return {Promise} Resolves with the fetched records
   */
  findAll(store, type) {
    return new RSVP.Promise(bind(this, (resolve, reject) => {
      const modelName = type.modelName;
      const ref = this._getFirebaseReference(modelName);

      ref.on('value', bind(this, (snapshot) => {
        const findRecordPromises = [];

        if (snapshot.exists()) {
          snapshot.forEach((child) => {
            findRecordPromises.push(this.findRecord(store, type, child.key));
          });

          RSVP.all(findRecordPromises).then(bind(this, (records) => {
            this._setupListListener(store, modelName);
            ref.off('value');
            resolve(records);
          })).catch(bind(this, (error) => {
            reject(new Error(error));
          }));
        } else {
          reject(new Error('Record doesn\'t exist'));
        }
      }), bind(this, (error) => {
        reject(new Error(error));
      }));
    }));
  },

  /**
   * Deletes a record
   *
   * @param {DS.Store} store
   * @param {DS.Model} type
   * @param {DS.Snapshot} snapshot
   * @return {Promise} Resolves once the record has been deleted
   */
  deleteRecord(store, type, snapshot) {
    return new RSVP.Promise(bind(this, (resolve, reject) => {
      const modelName = this._getParsedModelName(type.modelName);
      const id = snapshot.id;
      const adapterOptions = snapshot.adapterOptions;
      const fanout = {};

      if (adapterOptions) {
        if (adapterOptions.hasOwnProperty('include')) {
          assign(fanout, adapterOptions.include);
        }

        if (adapterOptions.hasOwnProperty('path')) {
          fanout[`${adapterOptions.path}/${id}`] = null;
        } else {
          fanout[`${modelName}/${id}`] = null;
        }
      }

      this.get('firebase').update(fanout, bind(this, (error) => {
        if (error) {
          reject(new Error(error));
        } else {
          resolve();
        }
      }));
    }));
  },

  /**
   * Queries for a single record
   *
   * @param {DS.Store} store
   * @param {DS.Model} type
   * @param {Object} [query={}]
   * @return {Promise} Resolves with the queried record
   */
  queryRecord(store, type, query = {}) {
    return new RSVP.Promise(bind(this, (resolve, reject) => {
      const path = query.path;
      const onValue = bind(this, (snapshot) => {
        if (snapshot.exists()) {
          // Will always loop once because of the forced limitTo* 1
          snapshot.forEach((child) => {
            const snapshot = {};

            if (path && !query.isReference) {
              snapshot.adapterOptions = { path: path };
            }

            this.findRecord(store, type, child.key, snapshot).then((record) => {
              ref.off('value', onValue);
              resolve(record);
            }).catch((error) => {
              reject(new Error(error));
            });
          });
        } else {
          reject(new Error('Record doesn\'t exist'));
        }
      });

      let ref = this._getFirebaseReference(type.modelName, undefined, path);

      ref = this._setupQuerySortingAndFiltering(ref, query, true);

      ref.on('value', onValue, bind(this, (error) => {
        reject(new Error(error));
      }));
    }));
  },

  /**
   * Queries for some records
   *
   * @param {DS.Store} store
   * @param {DS.Model} type
   * @param {Object} [query={}]
   * @param {DS.AdapterPopulatedRecordArray} recordArray
   * @return {Promise} Resolves with the queried record
   */
  query(store, type, query = {}, recordArray) {
    return new RSVP.Promise(bind(this, (resolve, reject) => {
      const path = query.path;
      const recordPath = path && !query.isReference ? path : null;
      const modelName = type.modelName;
      const onValue = bind(this, (snapshot) => {
        const findRecordPromises = [];

        if (snapshot.exists()) {
          snapshot.forEach((child) => {
            const snapshot = {
              adapterOptions: { path: recordPath },
            };

            findRecordPromises.push(this.findRecord(
                store, type, child.key, snapshot));
          });
        }

        RSVP.all(findRecordPromises).then(bind(this, (records) => {
          if (query.hasOwnProperty('cacheId')) {
            this._setupQueryListListener(
                store, modelName, recordPath, recordArray, ref);
            this._trackQuery(query.cacheId, recordArray);
          }

          ref.off('value', onValue);
          resolve(records);
        })).catch(bind(this, (error) => {
          reject(new Error(error));
        }));
      });

      let ref = this._getFirebaseReference(modelName, undefined, path);

      ref = this._setupQuerySortingAndFiltering(ref, query);

      ref.on('value', onValue, bind(this, (error) => {
        reject(new Error(error));
      }));
    }));
  },

  /**
   * Builds the path for a type
   *
   * @param {string} modelName
   * @param {string} id
   * @param {Object} adapterOptions
   * @return {string} Path
   * @private
   */
  buildPath(modelName, id, adapterOptions) {
    let path;

    if (adapterOptions && adapterOptions.path) {
      path = `${adapterOptions.path}/${id}`;
    } else {
      const parsedModelName = this.parseModelName(modelName);

      path = `${parsedModelName}/${id}`;
    }

    return path;
  },

  /**
   * Returns a model name in its camelized and pluralized form
   *
   * @param {string} modelName
   * @return {string} Camelized and pluralized model name
   * @private
   */
  parseModelName(modelName) {
    return camelize(pluralize(modelName));
  },

  /**
   * Builds a Firebase reference for a path
   *
   * @param {string} path
   * @return {firebase.database.Reference} Firebase reference
   * @private
   */
  buildFirebaseReference(path) {
    return this.get('firebase').child(path);
  },

  /**
   * Listens for changes in the record
   *
   * @param {DS.Store} store
   * @param {string} modelName
   * @param {string} id
   * @param {firebase.database.Reference} ref
   * @private
   */
  listenForRecordChanges(store, modelName, id, ref) {
    if (!this.isInFastBoot()) {
      if (!this.isTrackingRecordChanges(modelName, id)) {
        this.trackRecord(modelName, id, ref);

        ref.on('value', bind(this, (snapshot) => {
          if (snapshot.exists()) {
            const snapshotWithId = this.mergeSnapshotIdAndValue(snapshot);
            const normalizedRecord = store.normalize(modelName, snapshotWithId);

            next(() => {
              store.push(normalizedRecord);
            });
          } else {
            this.unloadRecord(store, modelName, id);
          }
        }), bind(this, (error) => {
          this.unloadRecord(store, modelName, id);
        }));
      }
    }
  },

  /**
   * Checks if in FastBoot
   *
   * @return {boolean} True if in FastBoot. Otherwise, false.
   * @private
   */
  isInFastBoot() {
    const fastboot = this.get('fastboot');

    return fastboot && fastboot.get('isFastBoot');
  },

  /**
   * Checks if changes to record is being tracked
   *
   * @param {string} modelName
   * @param {string} id
   * @return {boolean} True if being tracked. Otherwise, false.
   * @private
   */
  isTrackingRecordChanges(modelName, id) {
    const trackedRecords = this.get('trackedRecords');

    if (trackedRecords.hasOwnProperty(modelName)) {
      if (trackedRecords[modelName].hasOwnProperty(id)) {
        return true;
      }
    }

    return false;
  },

  /**
   * Tracks a record
   *
   * @param {string} modelName
   * @param {string} id
   * @param {firebase.database.Reference} ref
   * @private
   */
  trackRecord(modelName, id, ref) {
    const trackedRecords = this.get('trackedRecords');

    trackedRecords[modelName] = {};
    trackedRecords[modelName][id] = this.parseFirebaseReferencePath(ref);
  },

  /**
   * Gets the path of a Firebase reference without its origin
   *
   * @param {firebase.database.Reference} ref
   * @return {string} Path
   * @private
   */
  parseFirebaseReferencePath(ref) {
    return ref.toString().substring(ref.root.toString().length);
  },

  /**
   * Merges a snapshot's key with its value in a single object
   *
   * @param {firebase.database.DataSnapshot} snapshot
   * @return {Object} Snapshot
   * @private
   */
  mergeSnapshotIdAndValue(snapshot) {
    const ref = snapshot.ref;
    const referencePath = ref.toString().substring(ref.root.toString().length);
    const pathNodes = referencePath.split('/');

    pathNodes.shift();
    pathNodes.pop();

    const newSnapshot = snapshot.val();

    newSnapshot.id = snapshot.key;
    newSnapshot[this.get('innerReferencePathName')] = pathNodes.join('/');

    return newSnapshot;
  },

  /**
   * Unloads a record
   *
   * @param {DS.Store} store
   * @param {string} modelName
   * @param {string} id
   * @private
   */
  unloadRecord(store, modelName, id) {
    const record = store.peekRecord(modelName, id);

    if (record && !record.get('isSaving')) {
      store.unloadRecord(record);
    }
  },

  /**
   * Sets up listener that updates a records whenever it changes in
   * Firebase
   *
   * @param {DS.Store} store
   * @param {string} modelName
   * @param {string} id
   * @param {string} path
   * @private
   */
  _setupValueListener(store, modelName, id, path) {
    const fastboot = this.get('fastboot');

    if (!fastboot || !fastboot.get('isFastBoot')) {
      const key = path ?
          `${path}/${id}` : `${this._getParsedModelName(modelName)}/${id}`;

      if (!this._isListenerTracked(key, 'value')) {
        this._trackListener(key, 'value');

        const ref = this._getFirebaseReference(modelName, id, path);

        ref.on('value', bind(this, (snapshot) => {
          if (snapshot.exists()) {
            const snapshotWithId = this._getGetSnapshotWithId(snapshot);
            const normalizedRecord = store.normalize(modelName, snapshotWithId);

            next(() => {
              store.push(normalizedRecord);
            });
          } else {
            this._unloadRecord(store, modelName, id);
          }
        }), bind(this, (error) => {
          this._unloadRecord(store, modelName, id);
        }));
      }
    }
  },

  /**
   * Sets up listener that adds records to the store for a certain
   * model whenever a data gets added in Firebase
   *
   * @param {DS.Store} store
   * @param {string} modelName
   * @private
   */
  _setupListListener(store, modelName) {
    const fastboot = this.get('fastboot');

    if (!fastboot || !fastboot.get('isFastBoot')) {
      const path = `${this._getParsedModelName(modelName)}`;

      if (!this._isListenerTracked(path, 'child_added')) {
        this._trackListener(path, 'child_added');

        const ref = this._getFirebaseReference(modelName);

        ref.on('child_added', bind(this, (snapshot) => {
          this._setupValueListener(store, modelName, snapshot.key);
        }));
      }
    }
  },

  /**
   * Sets up a listener that updates the result of queries for every
   * new or removed records in Firebase
   *
   * @param {DS.Store} store
   * @param {string} modelName
   * @param {string} recordPath
   * @param {DS.AdapterPopulatedRecordArray} recordArray
   * @param {firebase.database.DataSnapshot} ref
   * @private
   */
  _setupQueryListListener(store, modelName, recordPath, recordArray, ref) {
    const fastboot = this.get('fastboot');

    if (!fastboot || !fastboot.get('isFastBoot')) {
      const onChildAdded = bind(this, (snapshot) => {
        store.findRecord(modelName, snapshot.key, {
          adapterOptions: { path: recordPath },
        }).then((record) => {
          // We're using a private API here and will likely break
          // without warning. We need to make sure that our acceptance
          // tests will capture this even if indirectly.
          recordArray.get('content').addObject(record._internalModel);
        });
      });

      ref.on('child_added', onChildAdded);

      const onChildRemoved = bind(this, (snapshot) => {
        const record = recordArray.get('content').findBy('id', snapshot.key);

        if (record) {
          recordArray.get('content').removeObject(record);
        }
      });

      ref.on('child_removed', onChildRemoved);

      this._setupRecordExtensions(
          recordArray, ref, onChildAdded, onChildRemoved);
    }
  },

  /**
   * Sets up properties in query results that allows to load more
   * data in its result
   *
   * @param {DS.AdapterPopulatedRecordArray} recordArray
   * @param {firebase.database.DataSnapshot} ref
   * @param {function} onChildAdded
   * @param {function} onChildRemoved
   * @private
   */
  _setupRecordExtensions(recordArray, ref, onChildAdded, onChildRemoved) {
    recordArray.set('firebase', {
      next(numberOfRecords) {
        ref.off('child_added', onChildAdded);
        ref.off('child_removed', onChildRemoved);

        const query = recordArray.get('query');

        if (query.hasOwnProperty('limitToFirst')) {
          query.limitToFirst += numberOfRecords;
        }

        if (query.hasOwnProperty('limitToLast')) {
          query.limitToLast += numberOfRecords;
        }

        return recordArray.update();
      },

      off() {
        ref.off('child_added', onChildAdded);
        ref.off('child_removed', onChildRemoved);
      },
    });
  },

  /**
   * Sets up sorting and filtering for queries
   *
   * @param {firebase.database.DataSnapshot} ref
   * @param {Object} query
   * @param {boolean} isForcingLimitToOne
   * @return {firebase.database.DataSnapshot} Reference with sort/filters
   * @private
   */
  _setupQuerySortingAndFiltering(ref, query, isForcingLimitToOne) {
    if (!query.hasOwnProperty('orderBy')) {
      query.orderBy = 'id';
    }

    if (query.orderBy === 'id') {
      ref = ref.orderByKey();
    } else if (query.orderBy === '.value') {
      ref = ref.orderByValue();
    } else {
      ref = ref.orderByChild(query.orderBy);
    }

    if (isForcingLimitToOne) {
      if (query.hasOwnProperty('limitToFirst') ||
          query.hasOwnProperty('limitToLast')) {
        if (query.hasOwnProperty('limitToFirst')) {
          query.limitToFirst = 1;
        } else {
          query.limitToLast = 1;
        }
      } else {
        query.limitToFirst = 1;
      }
    }

    [
      'startAt',
      'endAt',
      'equalTo',
      'limitToFirst',
      'limitToLast',
    ].forEach((type) => {
      if (query.hasOwnProperty(type)) {
        ref = ref[type](query[type]);
      }
    });

    return ref;
  },

  /**
   * Returns the Firebase snapshot with an ID property
   *
   * @param {firebase.database.DataSnapshot} snapshot
   * @return {Object} Snapshot with ID
   * @private
   */
  _getGetSnapshotWithId(snapshot) {
    const ref = snapshot.ref;
    const referencePath = ref.toString().substring(ref.root.toString().length);
    const pathNodes = referencePath.split('/');

    pathNodes.shift();
    pathNodes.pop();

    const newSnapshot = snapshot.val();

    newSnapshot.id = snapshot.key;
    newSnapshot[this.get('innerReferencePathName')] = pathNodes.join('/');

    return newSnapshot;
  },

  /**
   * Returns the Firebase reference for a model
   *
   * @param {string} modelName
   * @param {string} [id='']
   * @param {string} [path]
   * @return {firebase.database.DataSnapshot} Firebase reference
   * @private
   */
  _getFirebaseReference(modelName, id = '', path) {
    const firebase = this.get('firebase');

    if (path) {
      return firebase.child(`${path}/${id}`);
    } else {
      return firebase.child(`${this._getParsedModelName(modelName)}/${id}`);
    }
  },

  /**
   * Returns a model name in its camelized and pluralized form
   *
   * @param {string} modelName
   * @return {string} Camelized and pluralized model name
   */
  _getParsedModelName(modelName) {
    return camelize(pluralize(modelName));
  },

  /**
   * Unloads a record
   *
   * @param {DS.Store} store
   * @param {string} modelName
   * @param {string} id
   * @private
   */
  _unloadRecord(store, modelName, id) {
    const record = store.peekRecord(modelName, id);

    if (record && !record.get('isSaving')) {
      store.unloadRecord(record);
    }
  },

  /**
   * Checks if a listener was already set up for a record
   *
   * @param {string} key trackedListeners key
   * @param {string} type Type of listener (value, child_added, etc.)
   * @return {boolean} True if already tracked. Otherwise, false.
   * @private
   */
  _isListenerTracked(key, type) {
    const trackedListeners = this.get('trackedListeners');

    return trackedListeners.hasOwnProperty(key) && trackedListeners[key][type];
  },

  /**
   * Tracks a type of listener that's been setup for a record
   *
   * @param {string} key trackedListeners key
   * @param {string} type Type of listener (value, child_added, etc.)
   * @private
   */
  _trackListener(key, type) {
    const trackedListeners = this.get('trackedListeners');
    const tempTrackedListeners = assign({}, trackedListeners);

    if (!tempTrackedListeners.hasOwnProperty(key)) {
      tempTrackedListeners[key] = {};
    }

    tempTrackedListeners[key][type] = true;

    this.set('trackedListeners', assign(
        {}, trackedListeners, tempTrackedListeners));
  },

  /**
   * Tracks a query request
   *
   * @param {string} cacheId
   * @param {DS.AdapterPopulatedRecordArray} recordArray
   * @private
   */
  _trackQuery(cacheId, recordArray) {
    const fastboot = this.get('fastboot');

    if (!fastboot || !fastboot.get('isFastBoot')) {
      const trackedQueries = this.get('trackedQueries');
      const trackedQueryCache = trackedQueries[cacheId];

      if (trackedQueryCache) {
        trackedQueryCache.get('firebase').off();
      }

      const trackedQuery = {};

      trackedQuery[cacheId] = recordArray;

      this.set('trackedQueries', assign({}, trackedQueries, trackedQuery));
    }
  },
});
