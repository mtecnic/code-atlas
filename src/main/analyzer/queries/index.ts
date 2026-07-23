// tree-sitter queries per grammar. One combined query per language; capture
// name prefixes route matches: import.* → import specifiers, def.* → symbol
// definitions, ref.* → call/reference sites.

const JS_COMMON = `
(import_statement source: (string (string_fragment) @import.source))
(export_statement source: (string (string_fragment) @import.source))
(call_expression
  function: (identifier) @_req
  arguments: (arguments (string (string_fragment) @import.source))
  (#eq? @_req "require"))

(function_declaration name: (identifier) @def.function)
(generator_function_declaration name: (identifier) @def.function)
(class_declaration name: (identifier) @def.class)
(method_definition name: (property_identifier) @def.method)
(variable_declarator name: (identifier) @def.variable)

(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression property: (property_identifier) @ref.call))
(new_expression constructor: (identifier) @ref.call)
`

const TS_EXTRA = `
(interface_declaration name: (type_identifier) @def.type)
(type_alias_declaration name: (type_identifier) @def.type)
(enum_declaration name: (identifier) @def.type)
`

export const QUERIES: Record<string, string> = {
  javascript: JS_COMMON,
  typescript: JS_COMMON + TS_EXTRA,
  tsx: JS_COMMON + TS_EXTRA,

  python: `
(import_statement name: (dotted_name) @import.source)
(import_statement name: (aliased_import name: (dotted_name) @import.source))
(import_from_statement module_name: (dotted_name) @import.source)
(import_from_statement module_name: (relative_import) @import.source)

(function_definition name: (identifier) @def.function)
(class_definition name: (identifier) @def.class)
(module (expression_statement (assignment left: (identifier) @def.variable)))

(call function: (identifier) @ref.call)
(call function: (attribute attribute: (identifier) @ref.call))
`,

  go: `
(import_spec path: (interpreted_string_literal) @import.source)

(function_declaration name: (identifier) @def.function)
(method_declaration name: (field_identifier) @def.method)
(type_declaration (type_spec name: (type_identifier) @def.type))
(var_declaration (var_spec name: (identifier) @def.variable))
(const_declaration (const_spec name: (identifier) @def.variable))

(call_expression function: (identifier) @ref.call)
(call_expression function: (selector_expression field: (field_identifier) @ref.call))
`,

  rust: `
(use_declaration argument: (_) @import.source)
(mod_item name: (identifier) @import.module)

(function_item name: (identifier) @def.function)
(struct_item name: (type_identifier) @def.type)
(enum_item name: (type_identifier) @def.type)
(trait_item name: (type_identifier) @def.type)
(static_item name: (identifier) @def.variable)
(const_item name: (identifier) @def.variable)

(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression field: (field_identifier) @ref.call))
(call_expression function: (scoped_identifier name: (identifier) @ref.call))
(macro_invocation macro: (identifier) @ref.call)
`,

  c: `
(preproc_include path: (string_literal) @import.source)

(function_definition declarator: (function_declarator declarator: (identifier) @def.function))
(type_definition declarator: (type_identifier) @def.type)
(struct_specifier name: (type_identifier) @def.type)
(enum_specifier name: (type_identifier) @def.type)

(call_expression function: (identifier) @ref.call)
`,

  cpp: `
(preproc_include path: (string_literal) @import.source)

(function_definition declarator: (function_declarator declarator: (identifier) @def.function))
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @def.method)))
(function_definition declarator: (function_declarator declarator: (field_identifier) @def.method))
(class_specifier name: (type_identifier) @def.class)
(struct_specifier name: (type_identifier) @def.type)
(enum_specifier name: (type_identifier) @def.type)
(type_definition declarator: (type_identifier) @def.type)

(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression field: (field_identifier) @ref.call))
(call_expression function: (qualified_identifier name: (identifier) @ref.call))
`,

  java: `
(import_declaration (scoped_identifier) @import.source)

(class_declaration name: (identifier) @def.class)
(interface_declaration name: (identifier) @def.type)
(enum_declaration name: (identifier) @def.type)
(record_declaration name: (identifier) @def.type)
(method_declaration name: (identifier) @def.method)
(field_declaration declarator: (variable_declarator name: (identifier) @def.variable))

(method_invocation name: (identifier) @ref.call)
(object_creation_expression type: (type_identifier) @ref.call)
`
}
