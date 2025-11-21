export default function FiltersSidebar() {
  return (
    <div className="bg-gray-800 w-60 p-4 text-gray-200 space-y-4">
      <h2 className="text-lg font-semibold mb-2 border-b border-gray-700 pb-1">
        Filters
      </h2>
      <div>
        <label className="block mb-1 text-sm">Max Price</label>
        <input
          type="number"
          className="w-full px-2 py-1 rounded bg-gray-700 text-gray-100 focus:ring-green-400 focus:ring-1"
          placeholder="e.g. 300"
        />
      </div>
      <div>
        <label className="block mb-1 text-sm">Condition</label>
        <select className="w-full bg-gray-700 rounded px-2 py-1 focus:ring-green-400 focus:ring-1">
          <option>Any</option>
          <option>New</option>
          <option>Used</option>
        </select>
      </div>
    </div>
  );
}
