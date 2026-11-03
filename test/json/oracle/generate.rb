# frozen_string_literal: true

# Regenerates test/json/fixtures/oracle.json: a bundle exported by
# lutaml-model's LML exporter plus replay cases whose expectations come from
# running the real Ruby serializers. Run from a lutaml-model checkout that has
# the 01-03c work (the 03c branch):
#
#   bundle exec ruby -Ilib <this file> <output.json>
#
# Integers and decimals are deliberately absent: the portable wire profile
# (portable-exact-json-v1) carries them as strings, which Ruby's own integer
# type does not.
require "lutaml/model"
require "json"

module OracleModels
  class Tag < Lutaml::Model::Serializable
    attribute :name, :string
    json { map "name", to: :name }
  end

  class Rec < Lutaml::Model::Serializable
    attribute :label, :string
    attribute :flag, :boolean
    attribute :tags, :string, collection: true
    attribute :child, Tag
    attribute :kids, Tag, collection: true
    attribute :meta, :hash
    attribute :nn, :string
    attribute :ne, :string
    attribute :nl, :string, collection: true
    attribute :ea, :string
    attribute :ee, :string
    attribute :plain, :string
    json do
      map %w[label lbl lab], to: :label
      map "flag", to: :flag
      map "tags", to: :tags
      map "child", to: :child
      map "kids", to: :kids
      map "meta", to: :meta
      map "nn", to: :nn, render_nil: :as_nil
      map "ne", to: :ne, render_nil: :as_empty
      map "nl", to: :nl, render_nil: :as_empty
      map "ea", to: :ea, render_empty: :as_nil
      map "ee", to: :ee, render_empty: :as_empty
      map "plain", to: :plain
    end
  end

  class Animal < Lutaml::Model::Serializable
    attribute :kind, :string
    attribute :name, :string
    json do
      map "kind", to: :kind
      map "name", to: :name
    end
  end

  class Dog < Animal; end

  class Kennel < Lutaml::Model::Serializable
    attribute :animals, Animal, collection: true
    attribute :pet, Animal
    attribute :owner, :string
    poly = { attribute: "kind",
             class_map: { "dog" => "OracleModels::Dog", "animal" => "OracleModels::Animal" } }
    json do
      map "animals", to: :animals, polymorphic: poly
      map "pet", to: :pet, polymorphic: poly
      map "owner", to: :owner
    end
  end
end

# [id, model, input text, divergence note or nil]
CASES = [
  ["rec-empty-object", "Rec", "{}", nil],
  ["rec-scalars", "Rec", '{"label":"L","flag":true,"plain":"p"}', nil],
  ["rec-flag-false", "Rec", '{"flag":false}', nil],
  ["rec-alias-first", "Rec", '{"lbl":"via lbl"}', nil],
  ["rec-alias-third", "Rec", '{"lab":"via lab"}', nil],
  ["rec-alias-both-order-a", "Rec", '{"label":"A","lbl":"B"}', nil],
  ["rec-alias-both-order-b", "Rec", '{"lbl":"B","label":"A"}', nil],
  ["rec-tags", "Rec", '{"tags":["a","b"]}', nil],
  ["rec-tags-empty-omitted", "Rec", '{"tags":[]}', nil],
  ["rec-key-order-is-declaration-order", "Rec", '{"plain":"z","flag":true,"label":"a"}', nil],
  ["rec-nested", "Rec", '{"child":{"name":"c"},"kids":[{"name":"k1"},{"name":"k2"}]}', nil],
  ["rec-meta-hash", "Rec", '{"meta":{"a":[1,{"b":null}],"c":"d"}}', nil],
  ["rec-meta-empty-hash-omitted", "Rec", '{"meta":{}}', nil],
  ["rec-null-renders-as-nil", "Rec", '{"nn":null}', nil],
  ["rec-absent-renders-as-nil", "Rec", "{}", nil],
  ["rec-null-as-empty-scalar", "Rec", '{"ne":null}', nil],
  ["rec-null-as-empty-list", "Rec", '{"nl":null}', nil],
  ["rec-empty-as-nil", "Rec", '{"ea":""}', nil],
  ["rec-empty-as-empty", "Rec", '{"ee":""}', nil],
  ["rec-empty-default-omit", "Rec", '{"plain":""}', nil],
  ["rec-unknown-keys-ignored", "Rec", '{"plain":"p","zzz":1}', nil],
  ["rec-document-array", "Rec", "[1]", nil],
  ["rec-document-string", "Rec", '"s"', nil],
  ["rec-lone-value-wrapped", "Rec", '{"tags":"solo"}', "ts-keeps-lone-value-wrap"],
  ["rec-number-for-string", "Rec", '{"plain":5}', "ruby-lenient-ts-strict"],
  ["rec-string-for-boolean", "Rec", '{"flag":"true"}', "ruby-lenient-ts-strict"],
  ["kennel-poly-list", "Kennel",
   '{"animals":[{"kind":"dog","name":"Rex"},{"kind":"animal","name":"Tom"}],"owner":"Ann"}', nil],
  ["kennel-poly-single", "Kennel", '{"pet":{"kind":"dog","name":"Rex"}}', nil],
  ["kennel-poly-unknown-kind", "Kennel", '{"pet":{"kind":"cat","name":"Tom"}}', nil],
  ["kennel-poly-missing-kind", "Kennel", '{"pet":{"name":"Tom"}}', nil]
].freeze

def run_case(id, model, text, note)
  klass = OracleModels.const_get(model)
  entry = { "id" => id, "model_id" => "OracleModels::#{model}@default", "input" => text }
  entry["divergence"] = note if note
  begin
    instance = klass.from_json(text)
    entry["expected_output"] = JSON.generate(JSON.parse(instance.to_json))
    entry["ruby_class"] = instance.class.name
    if model == "Kennel"
      entry["ruby_classes"] = Array(instance.animals).map { |a| a.class.name.split("::").last } +
                              (instance.pet ? [instance.pet.class.name.split("::").last] : [])
    end
  rescue StandardError => e
    entry["expected_error"] = e.class.name
  end
  entry
end

roots = [OracleModels::Rec, OracleModels::Kennel]
bundle = Lutaml::Model::Lml.export_bundle(roots)
out = {
  "bundle" => JSON.parse(JSON.generate(bundle.to_h)),
  "cases" => CASES.map { |args| run_case(*args) }
}
File.write(ARGV.fetch(0), JSON.pretty_generate(out) + "\n")
puts "wrote #{out['cases'].size} cases"
