require "lutaml/model"
require "json"
class N < Lutaml::Model::Serializable
  attribute :id, :string
  attribute :other, :hash
  xml do
    root "n"
    map_attribute "id", to: :id
    map_all_attributes to: :other
  end
end
x = '<n xmlns:x="u" xmlns="d" id="1" x:a="2" b="3" xml:lang="en"/>'
m = N.from_xml(x)
puts JSON.generate(id: m.id, other: m.other)
puts N.new(id: "1", other: {"a"=>"2","b"=>"3","lang"=>"en"}).to_xml
puts N.new(id: "1", other: {"a"=>"2","k"=>nil, "n"=>3, "schemaLocation"=>"s"}).to_xml
puts JSON.generate(N.from_xml('<n id="1"/>').other)
m2 = N.from_xml('<n xmlns:x="u" xmlns:y="u" x:a="1" a="2" y:s="v" schemaLocation="z"/>')
puts JSON.generate(m2.other)
