# frozen_string_literal: true

# Regenerates test/xml/fixtures/oracle.json: a bundle exported by
# lutaml-model's LML exporter plus replay cases whose expectations come from
# running the real Ruby XML reader (from_xml), element_order capture and
# serializer (to_xml). Run from a lutaml-model checkout that has the LML work:
#
#   bundle exec ruby -Ilib <this file> <output.json>
#
# Per-rule namespaces cannot be declared with the current Ruby DSL (a
# namespace belongs to the model class), so rule-level uri/unqualified modes
# are covered by hand-written bundles in the TS tests, not by this oracle.
require "lutaml/model"
require "lutaml/xml"
require "json"

module XmlOracle
  class ExNs < Lutaml::Xml::Namespace
    uri "urn:ex"
    prefix_default "ex"
  end

  class AdNs < Lutaml::Xml::Namespace
    uri "urn:addr"
    prefix_default "ad"
  end

  class Addr < Lutaml::Model::Serializable
    attribute :city, :string
    xml do
      element "addr"
      namespace AdNs
      map_element "city", to: :city
    end
  end

  class Person < Lutaml::Model::Serializable
    attribute :id, :string
    attribute :lang, :string
    attribute :name, :string
    attribute :nick, :string
    attribute :tags, :string, collection: true
    attribute :addr, Addr
    attribute :age, :integer
    attribute :ni, :string
    attribute :nb, :string
    attribute :ee, :string
    xml do
      element "person"
      namespace ExNs
      map_attribute "id", to: :id
      map_attribute "lang", to: :lang
      map_element "name", to: :name
      map_element %w[nick alias], to: :nick
      map_element "tag", to: :tags
      map_element "addr", to: :addr
      map_element "age", to: :age
      map_element "ni", to: :ni, render_nil: :as_nil
      map_element "nb", to: :nb, render_nil: :as_blank
      map_element "ee", to: :ee, render_empty: :as_blank
    end
  end

  class Plain < Lutaml::Model::Serializable
    attribute :v, :string
    attribute :k, :string
    xml do
      element "plain"
      map_attribute "k", to: :k
      map_element "v", to: :v
    end
  end

  class Para < Lutaml::Model::Serializable
    attribute :text, :string, collection: true
    attribute :b, :string, collection: true
    attribute :i, :string, collection: true
    xml do
      element "p"
      ordered
      mixed_content
      map_content to: :text
      map_element "b", to: :b
      map_element "i", to: :i
    end
  end

  class Ord < Lutaml::Model::Serializable
    attribute :a, :string, collection: true
    attribute :c, :string, collection: true
    xml do
      element "ord"
      ordered
      map_element "a", to: :a
      map_element "c", to: :c
    end
  end

  class Animal < Lutaml::Model::Serializable
    attribute :kind, :string
    attribute :name, :string
    xml do
      element "animal"
      map_attribute "kind", to: :kind
      map_element "name", to: :name
    end
  end

  class Dog < Animal; end

  class Kennel < Lutaml::Model::Serializable
    attribute :pet, Animal
    attribute :owner, :string
    xml do
      element "kennel"
      map_element "pet", to: :pet,
                         polymorphic: { attribute: "kind",
                                        class_map: { "dog" => "XmlOracle::Dog", "animal" => "XmlOracle::Animal" } }
      map_element "owner", to: :owner
    end
  end
end

P = '<ex:person xmlns:ex="urn:ex" id="1" lang="en">'
# [id, model, input xml, divergence note or nil]
CASES = [
  ["person-full", "Person",
   %(#{P}<ex:name>N</ex:name><ex:alias>al</ex:alias><ex:tag>t1</ex:tag><ex:tag>t2</ex:tag>) +
   %(<ad:addr xmlns:ad="urn:addr"><ad:city>C</ad:city></ad:addr><ex:age>42</ex:age></ex:person>), nil],
  ["person-default-namespace", "Person", '<person xmlns="urn:ex" id="2"><name>D</name></person>', nil],
  ["person-unqualified-children", "Person", '<ex:person xmlns:ex="urn:ex"><name>U</name><tag>x</tag></ex:person>', nil],
  ["person-alias-first", "Person", '<person xmlns="urn:ex"><nick>a</nick></person>', nil],
  ["person-alias-second", "Person", '<person xmlns="urn:ex"><alias>b</alias></person>', nil],
  ["person-alias-both-first-wins", "Person", '<person xmlns="urn:ex"><nick>a</nick><alias>b</alias></person>', nil],
  ["person-scalar-duplicate-first-wins", "Person", '<person xmlns="urn:ex"><name>1</name><name>2</name></person>', nil],
  ["person-unknown-ignored", "Person", '<person xmlns="urn:ex" zz="1"><zz>1</zz><name>N</name></person>', nil],
  ["person-entities-and-cdata", "Person", '<person xmlns="urn:ex"><name>a &amp; b &lt; <![CDATA[c<>]]></name></person>', nil],
  ["person-empty-elements-nil-policies", "Person", '<person xmlns="urn:ex"><ni/><nb/><ee/><age/></person>', nil],
  ["person-empty-no-elements", "Person", '<person xmlns="urn:ex"/>', nil],
  ["person-empty-attribute", "Person", '<person xmlns="urn:ex" id=""/>', nil],
  ["person-nested-empty-child", "Person", '<person xmlns="urn:ex"><addr xmlns="urn:addr"/></person>', nil],
  ["person-prefixed-attribute-lenient", "Person",
   '<ex:person xmlns:ex="urn:ex" xmlns:a="urn:attr" a:lang="en"/>', "ruby-matches-prefixed-attribute-by-local-name"],
  ["person-nil-marker-ignored", "Person",
   '<person xmlns="urn:ex" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><ni xsi:nil="true"/></person>', "ruby-ignores-xsi-nil"],
  ["person-wrong-root", "Person", '<other xmlns="urn:ex"><name>N</name></other>', "ruby-accepts-any-root-name"],
  ["person-wrong-namespace", "Person", '<person xmlns="urn:zzz"><name>N</name></person>', "ruby-accepts-any-root-namespace"],
  ["person-bad-integer", "Person", '<person xmlns="urn:ex"><age>abc</age></person>', "ruby-lenient-ts-strict"],
  ["person-malformed", "Person", '<person xmlns="urn:ex"', nil],
  ["plain-no-namespace", "Plain", '<plain k="q"><v>1</v></plain>', nil],
  ["para-interleaved", "Para", '<p>a<b>x</b>c<i>y</i>d<b>z</b></p>', nil],
  ["para-whitespace-kept", "Para", "<p>\n  <b>x</b>\n  tail\n</p>", nil],
  ["para-text-only", "Para", "<p>only</p>", nil],
  ["para-empty", "Para", "<p/>", nil],
  ["para-cdata-token", "Para", "<p>a<![CDATA[raw]]><b>x</b></p>", nil],
  ["para-comment-refused", "Para", "<p>a<!--c--><b>x</b></p>", "ruby-reads-ts-refuses-comment-order"],
  ["ord-element-only-indentation-skipped", "Ord", "<ord>\n  <a>1</a>\n  <c>2</c>\n  <a>3</a>\n</ord>", nil],
  ["ord-repeated-interleaved", "Ord", "<ord><c>1</c><a>2</a><c>3</c><a>4</a></ord>", nil],
  ["kennel-poly-dog", "Kennel", '<kennel><pet kind="dog"><name>Rex</name></pet><owner>Ann</owner></kennel>', nil],
  ["kennel-poly-animal", "Kennel", '<kennel><pet kind="animal"><name>Tom</name></pet></kennel>', nil],
  ["kennel-poly-missing-kind", "Kennel", "<kennel><pet><name>Tom</name></pet></kennel>", nil],
  ["kennel-poly-unknown-kind", "Kennel", '<kennel><pet kind="cat"><name>Tom</name></pet></kennel>', "ruby-falls-back-ts-refuses"]
].freeze

# Neutral dump shared with the TS test: nil stays null, a model is an object,
# integers are decimal strings, an empty collection is null (XML cannot
# express a present-but-empty collection), and ordered models carry their
# captured token list under __lml_content.
def dump(value)
  case value
  when Lutaml::Model::Serializable
    out = value.class.attributes.keys.to_h { |k| [k.to_s, dump(value.public_send(k))] }
    mapping = value.class.mappings_for(:xml)
    descriptor = Lutaml::Model::Lml::OrderedContent.descriptor_for(value.class, mapping: mapping)
    out["__lml_content"] = Lutaml::Model::Lml::OrderedContent.capture(descriptor, value) if descriptor
    out
  when Array then value.empty? ? nil : value.map { |v| dump(v) }
  when Integer then value.to_s
  else value
  end
end

def run_case(id, model, text, note)
  klass = XmlOracle.const_get(model)
  entry = { "id" => id, "model_id" => "XmlOracle::#{model}@default", "input" => text }
  entry["divergence"] = note if note
  begin
    instance = klass.from_xml(text)
    entry["expected_data"] = JSON.parse(JSON.generate(dump(instance)))
    entry["ruby_class"] = instance.class.name.split("::").last
    entry["ruby_xml"] = instance.to_xml
  rescue StandardError => e
    entry["expected_error"] = e.class.name
  end
  entry
end

roots = [XmlOracle::Person, XmlOracle::Plain, XmlOracle::Para, XmlOracle::Ord, XmlOracle::Kennel]
bundle = Lutaml::Model::Lml.export_bundle(roots)
out = {
  "bundle" => JSON.parse(JSON.generate(bundle.to_h)),
  "cases" => CASES.map { |args| run_case(*args) }
}
File.write(ARGV.fetch(0), JSON.pretty_generate(out) + "\n")
puts "wrote #{out['cases'].size} cases"
