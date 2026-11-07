# frozen_string_literal: true

# Ruby side of the mml pilot: parses each MathML file with Mml::V3 or Mml::V4
# (Math root), writes the neutral model data and the serialized XML.
#
#   cd <lutaml-model checkout with the LML work>
#   LML_MML_ROOT=<mml 2.4.7 gem root> bundle exec ruby -Ilib \
#     <this file> VERSION FILE_LIST OUT.jsonl
#
# VERSION is 3 or 4; FILE_LIST holds one path per line; OUT.jsonl gets one JSON
# object per input: {file, ok, data, output} or {file, ok:false, error, message}.
require "json"
require "timeout"
require "lutaml/model"
require "lutaml/model/lml"

version, list, out = ARGV
abort "usage: ruby_oracle.rb 3|4 FILE_LIST OUT.jsonl" unless %w[3 4].include?(version) && list && out

root = ENV.fetch("LML_MML_ROOT") { abort "set LML_MML_ROOT to the mml 2.4.7 gem root" }
$LOAD_PATH.unshift(File.join(root, "lib"))
require "mml"
require "mml/version"
mod = Mml.const_get("V#{version}")
mod::Configuration.populate_context! unless mod::Configuration.context
register = :"mml_v#{version}"
klass = mod.const_get(:Math)

def normalize(value, register)
  case value
  when Lutaml::Model::UninitializedClass then { "state" => "absent" }
  when Array then value.map { |item| normalize(item, register) }
  when Lutaml::Model::Serialize
    klass = value.class
    attributes = klass.attributes(register).to_h do |name, _attribute|
      [name.to_s, normalize(value.public_send(name), register)]
    end
    descriptor = Lutaml::Model::Lml::OrderedContent.descriptor_for(
      klass, mapping: klass.mappings_for(:xml, register), register: register
    )
    attributes["__lml_content"] = Lutaml::Model::Lml::OrderedContent.capture(descriptor, value) if descriptor
    attributes.merge("__lml_model" => "#{klass.name}@#{register}")
  when Integer then value.to_s
  else value
  end
end

File.open(out, "w") do |io|
  File.readlines(list, chomp: true).each do |file|
    row = { "file" => file, "mml_version" => Mml::VERSION }
    begin
      Timeout.timeout(30) do
        Lutaml::Model::Config.with_adapter(xml: :nokogiri) do
          record = klass.from_xml(File.read(file, encoding: "UTF-8"), register: register)
          row.merge!("ok" => true, "data" => normalize(record, register), "output" => record.to_xml(register: register))
        end
      end
    rescue Exception => e # rubocop:disable Lint/RescueException -- a corpus run records every failure by name
      raise if e.is_a?(NoMemoryError) || e.is_a?(SystemExit) || e.is_a?(Interrupt)

      row.merge!("ok" => false, "error" => e.class.name, "message" => e.message.to_s[0, 300])
    end
    io.puts JSON.generate(row)
  end
end
