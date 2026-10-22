// The labels beside the header's logo (Settings > Appearance > Labels) : PRODUCTION, EU, the
// customer's name... each a short text in one of the app's pill colours, shown or hidden, in
// the order of their position. Several instances open side by side read apart at a glance. A
// change shows at once in every open tab (the 'appearance' live event).
import CrudModel from './crud.model.js';
import Errors from '../lib/errors.js';
import mysql from './db.model.js';
import { LABEL_COLORS } from './settings.model.js';
import { moveOneStep } from './listOrder.js';

// the longest text kept (the column's size)
export const MAX_LABEL = 40;

class Label extends CrudModel {
  static modelName = 'label';

  /**
   * Checks the fields of a label being saved : a text, a known colour (grey when none), a
   * position that is a number.
   *
   * Args:
   *   data (object): the fields being saved.
   *   existing (object): the label as stored, on an update ; null on a create.
   *
   * Raises:
   *   BadRequestError: no text, an unknown colour, a position that is no number.
   */
  static normalise(data, existing = null) {
    if (!existing || data.name !== undefined) {
      const name = String(data.name ?? '').trim();
      if (!name) throw new Errors.BadRequestError('Missing required field: name');
      data.name = name.slice(0, MAX_LABEL);
    }
    if (!existing || data.color !== undefined) {
      const color = data.color || 'grey';
      if (!LABEL_COLORS.includes(color)) {
        throw new Errors.BadRequestError(`A label's colour is one of ${LABEL_COLORS.join(', ')}: '${color}' is not`);
      }
      data.color = color;
    }
    if (data.position !== undefined && data.position !== null && data.position !== '') {
      const position = Number(data.position);
      if (!Number.isInteger(position)) throw new Errors.BadRequestError(`A label's position is a whole number: '${data.position}' is not`);
      data.position = position;
    }
    if (!existing && data.enabled === undefined) data.enabled = 1;
  }

  // opts carries { fromSeed:true } for the declarative config seed only
  static async create(data, opts = {}) {
    this.normalise(data);
    // after the others, unless a place is given - or a repository's file makes it : its place is
    // the one its file says, else its column's (lib/repoObjects)
    if (!opts.fromRepo && (data.position === undefined || data.position === null || data.position === '')) {
      const res = await mysql.do('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM AnsibleForms.`labels`');
      data.position = res?.[0]?.next || 1;
    }
    const res = await super.create(this.modelName, data, opts);
    await this.applied();
    return res;
  }

  static async update(data, id, opts = {}) {
    const existing = await this.findById(id);
    if (!existing) throw new Errors.NotFoundError(`No label with id ${id}`);
    this.normalise(data, existing);
    const res = await super.update(this.modelName, data, id, opts);
    await this.applied();
    return res;
  }

  static async delete(id, opts = {}) {
    const res = await super.delete(this.modelName, id, opts);
    await this.applied();
    return res;
  }

  static async findAll() {
    const all = await super.findAll(this.modelName);
    return [...(all || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name).localeCompare(String(b.name)));
  }

  static async findById(id) {
    return super.findById(this.modelName, id);
  }

  static async findByName(name) {
    return super.findByName(this.modelName, name);
  }

  /**
   * Moves a label one place up or down among the labels : it and its neighbour swap places, the
   * labels numbered again 1, 2, 3... so the order never has two at one place.
   *
   * Args:
   *   id (number|string): the label.
   *   direction (string): 'up' (earlier in the header) or 'down'.
   *
   * Returns:
   *   Promise<boolean>: true when it moved (false : already first, or last).
   *
   * Raises:
   *   BadRequestError: another direction ; NotFoundError: no label has that id.
   */
  static async move(id, direction) {
    // the one rule of the ordered lists (models/listOrder.js), as the LDAP directories'
    if (!(await moveOneStep('labels', await this.findAll(), id, direction, 'label'))) return false;
    // the cached list holds the old places
    this.changed(this.modelName);
    await this.applied();
    return true;
  }

  /**
   * The labels the header shows : those enabled, in their order, as the public config carries
   * them (routes/v2/app.routes.js).
   *
   * Returns:
   *   Promise<object[]>: { name, color } of each.
   */
  static async findShown() {
    const res = await mysql.do('SELECT name, color FROM AnsibleForms.`labels` WHERE enabled = 1 ORDER BY position, name');
    return (res || []).map((r) => ({ name: r.name, color: r.color || 'grey' }));
  }

  /**
   * The labels changed : the header re-reads the config, on this node now and on the others
   * through the live event. Never fails the save.
   */
  static async applied() {
    try {
      const { forgetAppDefaults } = await import('../routes/v2/app.routes.js');
      const { publish } = await import('../lib/liveEvents.js');
      forgetAppDefaults();
      publish('appearance');
    } catch {
      // the next read of the config, within its cache's time, shows it
    }
  }
}

export default Label;
