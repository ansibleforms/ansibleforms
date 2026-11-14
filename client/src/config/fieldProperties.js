/******************************************************************/
/*                                                                */
/*  A form field's properties, as a form's Visual tab offers them */
/*  (components/AppFormVisualEditor.vue) : each its kind of input */
/*  - text, number, switch, a choice (an enum), a scalar (text or */
/*  a number), or YAML (a list, an object) - and for YAML what a  */
/*  new one starts as ; its description is in the languages       */
/*  (designer.fieldProp.<key>). The name, type, label, required,  */
/*  help, default, output and values are not here : the tab shows */
/*  them itself.                                                  */
/*                                                                */
/*  Generated from server/schema/form_schema.json ;               */
/*  tests/field-properties.test.js fails when the schema moves    */
/*  without it, or a language lacks a description.                */
/*                                                                */
/******************************************************************/

export const fieldProperties = [
  {
    key: 'placeholder',
    kind: 'text',
  },
  {
    key: 'group',
    kind: 'text',
  },
  {
    key: 'accept',
    kind: 'yaml',
    init: [],
  },
  {
    key: 'evalDefault',
    kind: 'switch',
  },
  {
    key: 'dateType',
    kind: 'select',
    options: ['date', 'datetime', 'year', 'month', 'time', 'week'],
  },
  {
    key: 'convertToUtc',
    kind: 'switch',
  },
  {
    key: 'asCredential',
    kind: 'switch',
  },
  {
    key: 'line',
    kind: 'text',
  },
  {
    key: 'width',
    kind: 'text',
  },
  {
    key: 'sameAs',
    kind: 'text',
  },
  {
    key: 'validIf',
    kind: 'yaml',
    init: {},
  },
  {
    key: 'validIfNot',
    kind: 'yaml',
    init: {},
  },
  {
    key: 'regex',
    kind: 'yaml',
    init: {},
  },
  {
    key: 'notIn',
    kind: 'yaml',
    init: {},
  },
  {
    key: 'in',
    kind: 'yaml',
    init: {},
  },
  {
    key: 'minValue',
    kind: 'scalar',
  },
  {
    key: 'maxValue',
    kind: 'scalar',
  },
  {
    key: 'minSize',
    kind: 'scalar',
  },
  {
    key: 'maxSize',
    kind: 'scalar',
  },
  {
    key: 'minLength',
    kind: 'scalar',
  },
  {
    key: 'maxLength',
    kind: 'scalar',
  },
  {
    key: 'expression',
    kind: 'text',
  },
  {
    key: 'ignoreIncomplete',
    kind: 'switch',
  },
  {
    key: 'noLog',
    kind: 'switch',
  },
  {
    key: 'keydown',
    kind: 'switch',
  },
  {
    key: 'refresh',
    kind: 'yaml',
    init: '',
  },
  {
    key: 'isHtml',
    kind: 'switch',
  },
  {
    key: 'runLocal',
    kind: 'switch',
  },
  {
    key: 'query',
    kind: 'text',
  },
  {
    key: 'jq',
    kind: 'text',
  },
  {
    key: 'outputObject',
    kind: 'switch',
  },
  {
    key: 'titleAdd',
    kind: 'text',
  },
  {
    key: 'titleEdit',
    kind: 'text',
  },
  {
    key: 'switch',
    kind: 'switch',
  },
  {
    key: 'columns',
    kind: 'yaml',
    init: [],
  },
  {
    key: 'pctColumns',
    kind: 'yaml',
    init: [],
  },
  {
    key: 'filterColumns',
    kind: 'yaml',
    init: [],
  },
  {
    key: 'allowDelete',
    kind: 'switch',
  },
  {
    key: 'allowInsert',
    kind: 'switch',
  },
  {
    key: 'readonlyColumns',
    kind: 'yaml',
    init: [],
  },
  {
    key: 'deleteMarker',
    kind: 'text',
  },
  {
    key: 'insertMarker',
    kind: 'text',
  },
  {
    key: 'updateMarker',
    kind: 'text',
  },
  {
    key: 'sticky',
    kind: 'switch',
  },
  {
    key: 'horizontal',
    kind: 'switch',
  },
  {
    key: 'editable',
    kind: 'switch',
  },
  {
    key: 'readonly',
    kind: 'switch',
  },
  {
    key: 'showLoadButton',
    kind: 'switch',
  },
  {
    key: 'showDownloadButton',
    kind: 'switch',
  },
  {
    key: 'yamlError',
    kind: 'yaml',
    init: {},
  },
  {
    key: 'valueColumn',
    kind: 'text',
  },
  {
    key: 'previewColumn',
    kind: 'text',
  },
  {
    key: 'placeholderColumn',
    kind: 'text',
  },
  {
    key: 'dbConfig',
    kind: 'yaml',
    init: '',
  },
  {
    key: 'model',
    kind: 'yaml',
    init: '',
  },
  {
    key: 'value',
    kind: 'yaml',
    init: '',
  },
  {
    key: 'multiple',
    kind: 'switch',
  },
  {
    key: 'size',
    kind: 'number',
  },
  {
    key: 'dependencyFn',
    kind: 'select',
    options: ['and', 'or', 'nand', 'nor'],
  },
  {
    key: 'dependencies',
    kind: 'yaml',
    init: [],
  },
  {
    key: 'hide',
    kind: 'switch',
  },
  {
    key: 'icon',
    kind: 'text',
  },
  {
    key: 'iconColor',
    kind: 'text',
  },
  {
    key: 'iconSize',
    kind: 'text',
  },
  {
    key: 'overlayIcon',
    kind: 'text',
  },
  {
    key: 'overlayIconTransform',
    kind: 'text',
  },
  {
    key: 'overlayIconColor',
    kind: 'text',
  },
  {
    key: 'overlayIconCircle',
    kind: 'switch',
  },
  {
    key: 'overlayIconText',
    kind: 'text',
  },
  {
    key: 'overlayIconTextPosition',
    kind: 'text',
  },
  {
    key: 'overlayIconTextColor',
    kind: 'text',
  },
  {
    key: 'subform',
    kind: 'text',
  },
];
