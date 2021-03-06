'use strict';

const MongoClient = require('mongodb').MongoClient;
const AdapterFactory = require('./factory');
const Redis = require('redis');

class AbstractAdapter {

  validateConfig(config) {

    if (!config['db']['url'])
      throw Error('db.url must be set up in config');

  }

  constructor(app_config) {
    this.config = app_config;

    let factory = new AdapterFactory(app_config);
    this.db = factory.getAdapter('nosql', app_config.db.driver);

    if (global.cache == null) {
      this.cache = Redis.createClient(this.config.redis); // redis client
      this.cache.on('error', function (err) { // workaround for https://github.com/NodeRedis/node_redis/issues/713
        global.cache = Redis.createClient(this.config.redis); // redis client
      });
      global.cache = this.cache;
    } else this.cache = global.cache;

    this.update_document = true; // should we update database with new data from API? @see productcategory where this is disabled

    this.total_count = 0;
    this.page_count = 0;
    this.page_size = 50;
    this.page = 0;
    this.current_context = {};

    this.use_paging = false;
    this.is_federated = false;

    this.validateConfig(this.config);
    this.processItems = this.processItems.bind(this);

    this.tasks_count = 0;
  }

  isValidFor(entity_type) {
    throw Error('isValidFor must be implemented in specific class');
  }

  getCurrentContext() {
    return this.current_context;
  }

  /**
   * Default done callback called after all main items are processed by processItems
   */
  defaultDoneCallback() {
    return;
  }

  /**
   * Run products/categories/ ... import 
   * @param {Object} context import context with parameter such "page", "size" and other search parameters
   */
  run(context) {

    this.current_context = context;

    if (!(this.current_context.transaction_key))
      this.current_context.transaction_key = new Date().getTime(); // the key used to filter out records NOT ADDED by this import


    this.db.connect((function () {
      logger.info("Connected correctly to server");
      logger.info("TRANSACTION KEY = " + this.current_context.transaction_key);

      this.onDone = this.current_context.done_callback ? (function () { this.defaultDoneCallback(); this.current_context.done_callback(); }).bind(this) : this.defaultDoneCallback;
      this.getSourceData(this.current_context).then(this.processItems);

    }).bind(this));

  }
  /**
   * Implement some item related operations - executed BEFORE saving to the database
   * @param {Object} item 
   */
  preProcessItem(item) {
    return new Promise(function (done, reject) { done(); });
  }

  /**
   * Remove records from database other than specific transaction_key
   * @param {int} transaction_key
   */
  cleanUp(transaction_key) {
    this.db.connect((function () {
      logger.info('Cleaning up with tsk = ' + transaction_key);
      this.db.cleanupByTransactionkey(this.getCollectionName(), transaction_key);
    }).bind(this));
  }

  prepareItems(items) {

    if (items.total_count)
      this.total_count = items.total_count;

    if (!Array.isArray(items))
      items = new Array(items);

    return items;
  }

  isFederated() {
    return this.is_federated;
  }

  processItems(items, level) {

    if (isNaN(level))
      level = 0;
    items = this.prepareItems(items);

    let count = items.length;
    let index = 0;

    if (count == 0) {
      logger.warn('No records to process!');
      return this.onDone(this);
    } else
      this.tasks_count += count;

    let db = this.db;
    if (!db)
      throw new Error('No db adapter connection established!');

    if (this.total_count)
      logger.info('Total count is: ' + this.total_count)

    items.map((item) => {


      this.preProcessItem(item).then((function (item) {

        this.tasks_count--;

        item.tsk = this.getCurrentContext().transaction_key; // transaction key for items that can be then cleaned up

        logger.info('Importing ' + index + ' of ' + count + ' - ' + this.getLabel(item) + ' with tsk = ' + item.tsk);
        logger.info('Tasks count = ' + this.tasks_count);

        if (this.update_document)
          this.db.updateDocument(this.getCollectionName(), this.normalizeDocumentFormat(item))
        else
          logger.debug('Skiping database update');

        if (item.children_data && item.children_data.length > 0) {
          logger.info('--L:' + level + ' Processing child items ...');
          this.processItems(item.children_data, level + 1);
        }

        if (this.tasks_count == 0) { // this is the last item!
          logger.info(' No tasks to process. All records processed!');
          this.db.close();

          return this.onDone(this);
        } else {

          if (index == (count - 1)) // page done!
          {
            logger.debug('--L:' + level + ' Level done!');

            if (level == 0) {

              if (this.use_paging && !this.isFederated()) { //TODO: paging should be refactored using queueing

                if (this.page >= (this.page_count - 1)) {
                  logger.info('All pages processed!');
                  this.db.close();

                  this.onDone(this);
                } else {

                  this.page++;
                  logger.debug('Switching page to ' + this.page);

                  this.getSourceData(this.getCurrentContext()).then(this.processItems);
                }

              }

            }
          }
        }

        index++;
      }).bind(this)).catch(function (reason) {
        logger.error(reason);
      });

    })

  }

}

module.exports = AbstractAdapter;
