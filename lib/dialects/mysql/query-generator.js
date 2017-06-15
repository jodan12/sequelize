'use strict';

var Utils = require('../../utils');
const _ = require('lodash');
const AbstractQueryGenerator = require('../abstract/query-generator');
const DataTypes = require('../../data-types');
const Dottie = require('dottie');
const util = require('util');

var QueryGenerator = {
  dialect: 'mysql',

  createSchema: function() {
    var query = 'SHOW TABLES';
    return Utils._.template(query)({});
  },

  showSchemasQuery: function() {
    return 'SHOW TABLES';
  },

  versionQuery: function() {
    return 'SELECT VERSION() as `version`';
  },

  createTableQuery: function(tableName, attributes, options) {
    options = Utils._.extend({
      engine: 'InnoDB',
      charset: null
    }, options || {});

    var self = this;

    var query = 'CREATE TABLE IF NOT EXISTS <%= table %> (<%= attributes%>) ENGINE=<%= engine %><%= comment %><%= charset %><%= collation %><%= initialAutoIncrement %>'
      , primaryKeys = []
      , foreignKeys = {}
      , attrStr = [];

    for (var attr in attributes) {
      if (attributes.hasOwnProperty(attr)) {
        var dataType = attributes[attr]
          , match;

        if (Utils._.includes(dataType, 'PRIMARY KEY')) {
          primaryKeys.push(attr);

          if (Utils._.includes(dataType, 'REFERENCES')) {
             // MySQL doesn't support inline REFERENCES declarations: move to the end
            match = dataType.match(/^(.+) (REFERENCES.*)$/);
            attrStr.push(this.quoteIdentifier(attr) + ' ' + match[1].replace(/PRIMARY KEY/, ''));
            foreignKeys[attr] = match[2];
          } else {
            attrStr.push(this.quoteIdentifier(attr) + ' ' + dataType.replace(/PRIMARY KEY/, ''));
          }
        } else if (Utils._.includes(dataType, 'REFERENCES')) {
          // MySQL doesn't support inline REFERENCES declarations: move to the end
          match = dataType.match(/^(.+) (REFERENCES.*)$/);
          attrStr.push(this.quoteIdentifier(attr) + ' ' + match[1]);
          foreignKeys[attr] = match[2];
        } else {
          attrStr.push(this.quoteIdentifier(attr) + ' ' + dataType);
        }
      }
    }

    var values = {
      table: this.quoteTable(tableName),
      attributes: attrStr.join(', '),
      comment: options.comment && Utils._.isString(options.comment) ? ' COMMENT ' + this.escape(options.comment) : '',
      engine: options.engine,
      charset: (options.charset ? ' DEFAULT CHARSET=' + options.charset : ''),
      collation: (options.collate ? ' COLLATE ' + options.collate : ''),
      initialAutoIncrement: (options.initialAutoIncrement ? ' AUTO_INCREMENT=' + options.initialAutoIncrement : '')
    }
    , pkString = primaryKeys.map(function(pk) { return this.quoteIdentifier(pk); }.bind(this)).join(', ');

    if (!!options.uniqueKeys) {
      Utils._.each(options.uniqueKeys, function(columns, indexName) {
        if (!columns.singleField) { // If it's a single field its handled in column def, not as an index
          if (!Utils._.isString(indexName)) {
            indexName = 'uniq_' + tableName + '_' + columns.fields.join('_');
          }
          values.attributes += ', UNIQUE ' + self.quoteIdentifier(indexName) + ' (' + Utils._.map(columns.fields, self.quoteIdentifier).join(', ') + ')';
        }
      });
    }

    if (pkString.length > 0) {
      values.attributes += ', PRIMARY KEY (' + pkString + ')';
    }

    for (var fkey in foreignKeys) {
      if (foreignKeys.hasOwnProperty(fkey)) {
        values.attributes += ', FOREIGN KEY (' + this.quoteIdentifier(fkey) + ') ' + foreignKeys[fkey];
      }
    }

    return Utils._.template(query)(values).trim() + ';';
  },

  showTablesQuery: function() {
    return 'SHOW TABLES;';
  },

  addColumnQuery: function(table, key, dataType) {
    var query = 'ALTER TABLE <%= table %> ADD <%= attribute %>;'
      , attribute = Utils._.template('<%= key %> <%= definition %>')({
        key: this.quoteIdentifier(key),
        definition: this.attributeToSQL(dataType, {
          context: 'addColumn',
          foreignKey: key
        })
      });

    return Utils._.template(query)({
      table: this.quoteTable(table),
      attribute: attribute
    });
  },

  removeColumnQuery: function(tableName, attributeName) {
    var query = 'ALTER TABLE <%= tableName %> DROP <%= attributeName %>;';
    return Utils._.template(query)({
      tableName: this.quoteTable(tableName),
      attributeName: this.quoteIdentifier(attributeName)
    });
  },

  changeColumnQuery: function(tableName, attributes) {
    var query = 'ALTER TABLE <%= tableName %> <%= query %>;';
    var attrString = [], constraintString = [];

    for (var attributeName in attributes) {
      var definition = attributes[attributeName];
      if (definition.match(/REFERENCES/)) {
        constraintString.push(Utils._.template('<%= fkName %> FOREIGN KEY (<%= attrName %>) <%= definition %>')({
          fkName: this.quoteIdentifier(attributeName + '_foreign_idx'),
          attrName: this.quoteIdentifier(attributeName),
          definition: definition.replace(/.+?(?=REFERENCES)/,'')
        }));
      } else {
        attrString.push(Utils._.template('`<%= attrName %>` `<%= attrName %>` <%= definition %>')({
          attrName: attributeName,
          definition: definition
        }));
      }
    }

    var finalQuery = '';
    if (attrString.length) {
      finalQuery += 'CHANGE ' + attrString.join(', ');
      finalQuery += constraintString.length ? ' ' : '';
    }
    if (constraintString.length) {
      finalQuery += 'ADD CONSTRAINT ' + constraintString.join(', ');
    }

    return Utils._.template(query)({
      tableName: this.quoteTable(tableName),
      query: finalQuery
    });
  },

  renameColumnQuery: function(tableName, attrBefore, attributes) {
    var query = 'ALTER TABLE <%= tableName %> CHANGE <%= attributes %>;';
    var attrString = [];

    for (var attrName in attributes) {
      var definition = attributes[attrName];

      attrString.push(Utils._.template('`<%= before %>` `<%= after %>` <%= definition %>')({
        before: attrBefore,
        after: attrName,
        definition: definition
      }));
    }

    return Utils._.template(query)({ tableName: this.quoteTable(tableName), attributes: attrString.join(', ') });
  },

handleSequelizeMethod(smth, tableName, factory, options, prepend) {
    if (smth instanceof Utils.Json) {
      // Parse nested object
      if (smth.conditions) {
        const conditions = _.map(this.parseConditionObject(smth.conditions), condition =>
          `${this.quoteIdentifier(_.first(condition.path))}->>'\$.${_.tail(condition.path).join('.')}' = '${condition.value}'`
        );

        return conditions.join(' and ');
      } else if (smth.path) {
        let str;

        // Allow specifying conditions using the postgres json syntax
        if (_.some(['->', '->>'], _.partial(_.includes, smth.path))) {
          str = smth.path;
        } else {
          // Also support json dot notation
          const path = smth.path.split('.');
          str = `${this.quoteIdentifier(_.first(path))}->>'\$.${_.tail(path).join(',')}'`;
        }

        if (smth.value) {
          str += util.format(' = %s', this.escape(smth.value));
        }

        return str;
      }
    } else {
      return AbstractQueryGenerator.handleSequelizeMethod.call(this, smth, tableName, factory, options, prepend);
    }
  },

  whereItemQuery(key, value, options) {
    options = options || {};

    let field = options.field || options.model && options.model.rawAttributes && options.model.rawAttributes[key] || options.model && options.model.fieldRawAttributesMap && options.model.fieldRawAttributesMap[key];
    let fieldType = options.type || (field && field.type);

    if (key && typeof key === 'string' && key.indexOf('.') !== -1 && options.model) {
      if (options.model.rawAttributes[key.split('.')[0]] && options.model.rawAttributes[key.split('.')[0]].type instanceof DataTypes.JSON) {
        field = options.model.rawAttributes[key.split('.')[0]];
        fieldType = field.type;
        const tmp = value;
        value = {};

        Dottie.set(value, key.split('.').slice(1), tmp);
        key = field.field || key.split('.')[0];
      }
    }

    if (_.isPlainObject(value) && fieldType instanceof DataTypes.JSON) {
      let prefix = '';
      if (options.prefix) {
        if (options.prefix instanceof Utils.Literal) {
          prefix = this.handleSequelizeMethod(options.prefix)+'.';
        } else {
          prefix = this.quoteTable(options.prefix)+'.';
        }
      }
      let prefixedKey = `${prefix}${this.quoteIdentifier(key)}`;

      if (options.json !== false) {
        const items = [];
        const traverse = (prop, item, path) => {
          const where = {};
          let cast;

          if (path[path.length - 1].indexOf('::') > -1) {
            const tmp = path[path.length - 1].split('::');
            cast = tmp[1];
            path[path.length - 1] = tmp[0];
          }

          let baseKey = `${prefixedKey}->>'\$.${path.join('.')}\'`;

          if (_.isPlainObject(item)) {
            _.forOwn(item, (item, prop) => {
              if (prop.indexOf('$') === 0) {
                where[prop] = item;
                items.push(this.whereItemQuery(new Utils.Literal(baseKey), where/*, _.pick(options, 'prefix')*/));
              } else {
                traverse(prop, item, path.concat([prop]));
              }
            });
          } else {
            where.$eq = item;
            items.push(this.whereItemQuery(new Utils.Literal(baseKey), where/*, _.pick(options, 'prefix')*/));
          }
        };

        _.forOwn(value, (item, prop) => {
          if (prop.indexOf('$') === 0) {
            const where = {};
            where[prop] = item;
            items.push(this.whereItemQuery(key, where, _.assign({}, options, {json: false})));
            return;
          }

          traverse(prop, item, [prop]);
        });

        const result = items.join(' AND ');
        return items.length > 1 ? '('+result+')' : result;
      } else {
        if (value.$contains) {
          return `JSON_CONTAINS(${prefixedKey}, '${JSON.stringify(value.$contains)}')`;
        }
      }
    }

    return AbstractQueryGenerator.whereItemQuery.call(this, key, value, options);
  },

  upsertQuery: function (tableName, insertValues, updateValues, where, rawAttributes, options) {
    options.onDuplicate = 'UPDATE ';

    options.onDuplicate += Object.keys(updateValues).map(function (key) {
      key = this.quoteIdentifier(key);
      return key + '=VALUES(' + key +')';
    }, this).join(', ');
    console.log('ddddddddddddddddddddddddddddddddddddddddddddddddddd');
    return this.insertQuery(tableName, insertValues, rawAttributes, options);
  },

  deleteQuery: function(tableName, where, options) {
    options = options || {};

    var table = this.quoteTable(tableName);
    if (options.truncate === true) {
      // Truncate does not allow LIMIT and WHERE
      return 'TRUNCATE ' + table;
    }

    where = this.getWhereConditions(where);
    var limit = '';

    if (Utils._.isUndefined(options.limit)) {
      options.limit = 1;
    }

    if (!!options.limit) {
      limit = ' LIMIT ' + this.escape(options.limit);
    }

    var query = 'DELETE FROM ' + table;
    if (where) query += ' WHERE ' + where;
    query += limit;

    return query;
  },

  showIndexesQuery: function(tableName, options) {
    var sql = 'SHOW INDEX FROM <%= tableName %><%= options %>';
    return Utils._.template(sql)({
      tableName: this.quoteTable(tableName),
      options: (options || {}).database ? ' FROM `' + options.database + '`' : ''
    });
  },

  removeIndexQuery: function(tableName, indexNameOrAttributes) {
    var sql = 'DROP INDEX <%= indexName %> ON <%= tableName %>'
      , indexName = indexNameOrAttributes;

    if (typeof indexName !== 'string') {
      indexName = Utils.inflection.underscore(tableName + '_' + indexNameOrAttributes.join('_'));
    }

    return Utils._.template(sql)({ tableName: this.quoteIdentifiers(tableName), indexName: indexName });
  },

  attributeToSQL: function(attribute, options) {
    if (!Utils._.isPlainObject(attribute)) {
      attribute = {
        type: attribute
      };
    }

    var template = attribute.type.toString({ escape: this.escape.bind(this) });

    if (attribute.allowNull === false) {
      template += ' NOT NULL';
    }

    if (attribute.autoIncrement) {
      template += ' auto_increment';
    }

    // Blobs/texts cannot have a defaultValue
    if (attribute.type !== 'TEXT' && attribute.type._binary !== true && Utils.defaultValueSchemable(attribute.defaultValue)) {
      template += ' DEFAULT ' + this.escape(attribute.defaultValue);
    }

    if (attribute.unique === true) {
      template += ' UNIQUE';
    }

    if (attribute.primaryKey) {
      template += ' PRIMARY KEY';
    }

    if (attribute.after) {
      template += ' AFTER ' + this.quoteIdentifier(attribute.after);
    }

    if (attribute.references) {
      attribute = Utils.formatReferences(attribute);

      if (options && options.context === 'addColumn' && options.foreignKey) {
        var attrName = options.foreignKey;
        
        template += Utils._.template(', ADD CONSTRAINT <%= fkName %> FOREIGN KEY (<%= attrName %>)')({
          fkName: this.quoteIdentifier(attrName + '_foreign_idx'),
          attrName: this.quoteIdentifier(attrName)
        });
      }

      template += ' REFERENCES ' + this.quoteTable(attribute.references.model);

      if (attribute.references.key) {
        template += ' (' + this.quoteIdentifier(attribute.references.key) + ')';
      } else {
        template += ' (' + this.quoteIdentifier('id') + ')';
      }

      if (attribute.onDelete) {
        template += ' ON DELETE ' + attribute.onDelete.toUpperCase();
      }

      if (attribute.onUpdate) {
        template += ' ON UPDATE ' + attribute.onUpdate.toUpperCase();
      }
    }

    return template;
  },

  attributesToSQL: function(attributes, options) {
    var result = {}
      , key
      , attribute;

    for (key in attributes) {
      attribute = attributes[key];
      result[attribute.field || key] = this.attributeToSQL(attribute, options);
    }

    return result;
  },

  findAutoIncrementField: function(factory) {
    var fields = [];

    for (var name in factory.attributes) {
      if (factory.attributes.hasOwnProperty(name)) {
        var definition = factory.attributes[name];

        if (definition && definition.autoIncrement) {
          fields.push(name);
        }
      }
    }

    return fields;
  },

  quoteIdentifier: function(identifier) {
    if (identifier === '*') return identifier;
    return Utils.addTicks(identifier, '`');
  },

  /**
   * Generates an SQL query that returns all foreign keys of a table.
   *
   * @param  {String} tableName  The name of the table.
   * @param  {String} schemaName The name of the schema.
   * @return {String}            The generated sql query.
   */
  getForeignKeysQuery: function(tableName, schemaName) {
    return "SELECT CONSTRAINT_NAME as constraint_name FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE where TABLE_NAME = '" + tableName + /* jshint ignore: line */
      "' AND CONSTRAINT_NAME!='PRIMARY' AND CONSTRAINT_SCHEMA='" + schemaName + "' AND REFERENCED_TABLE_NAME IS NOT NULL;"; /* jshint ignore: line */
  },

  /**
   * Generates an SQL query that returns the foreign key constraint of a given column.
   *
   * @param  {String} tableName  The name of the table.
   * @param  {String} columnName The name of the column.
   * @return {String}            The generated sql query.
   */
  getForeignKeyQuery: function(table, columnName) {
    var tableName = table.tableName || table;
    if (table.schema) {
        tableName = table.schema + '.' + tableName;
    }
    return [
      'SELECT CONSTRAINT_NAME as constraint_name',
      'FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE',
      'WHERE (REFERENCED_TABLE_NAME = ' + wrapSingleQuote(tableName),
        'AND REFERENCED_COLUMN_NAME = ' + wrapSingleQuote(columnName),
        ') OR (TABLE_NAME = ' + wrapSingleQuote(tableName),
        'AND COLUMN_NAME = ' + wrapSingleQuote(columnName),
        ')',
    ].join(' ');
  },

  /**
   * Generates an SQL query that removes a foreign key from a table.
   *
   * @param  {String} tableName  The name of the table.
   * @param  {String} foreignKey The name of the foreign key constraint.
   * @return {String}            The generated sql query.
   */
  dropForeignKeyQuery: function(tableName, foreignKey) {
    return 'ALTER TABLE ' + this.quoteTable(tableName) + ' DROP FOREIGN KEY ' + this.quoteIdentifier(foreignKey) + ';';
  }
};

// private methods
function wrapSingleQuote(identifier){
  return Utils.addTicks(identifier, '\'');
}

module.exports = Utils._.extend(Utils._.clone(require('../abstract/query-generator')), QueryGenerator);
