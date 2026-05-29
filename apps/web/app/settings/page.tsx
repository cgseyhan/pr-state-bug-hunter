import { Shield, GitBranch, Bell, Save } from "lucide-react";

export default function Settings() {
  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 py-8 px-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold">Repository Settings</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">Configure bug hunting rules for acme-corp/frontend-app-1.</p>
        </header>

        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 shadow-sm overflow-hidden">
          {/* Analysis Sensitivity */}
          <div className="p-6 border-b dark:border-gray-700">
            <div className="flex items-start">
              <Shield className="w-6 h-6 text-indigo-500 mt-1 mr-4" />
              <div className="flex-1">
                <h2 className="text-lg font-semibold">Analysis Sensitivity</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Set the threshold for what constitutes a bug. Higher sensitivity catches more issues but may increase false positives.</p>
                <select className="w-full md:w-1/2 p-2 border dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-sm">
                  <option>Low (Only Critical Bugs)</option>
                  <option>Medium (Standard)</option>
                  <option>High (Strict Static Analysis)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Auto Commenting */}
          <div className="p-6 border-b dark:border-gray-700">
            <div className="flex items-start">
              <Bell className="w-6 h-6 text-indigo-500 mt-1 mr-4" />
              <div className="flex-1">
                <h2 className="text-lg font-semibold">Auto-Comment on PRs</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Automatically post a review comment on the PR when bugs are found.</p>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" defaultChecked />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                  <span className="ml-3 text-sm font-medium">Enable Auto-Comments</span>
                </label>
              </div>
            </div>
          </div>

          {/* Target Branches */}
          <div className="p-6 border-b dark:border-gray-700">
            <div className="flex items-start">
              <GitBranch className="w-6 h-6 text-indigo-500 mt-1 mr-4" />
              <div className="flex-1">
                <h2 className="text-lg font-semibold">Target Branches</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Only analyze pull requests targeting these branches. Leave empty to analyze all PRs.</p>
                <input type="text" placeholder="main, develop" className="w-full md:w-1/2 p-2 border dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-sm" />
              </div>
            </div>
          </div>

          <div className="p-6 bg-gray-50 dark:bg-gray-800/50 flex justify-end">
            <button className="flex items-center space-x-2 bg-indigo-600 text-white px-6 py-2 rounded-lg hover:bg-indigo-700 transition-colors font-medium">
              <Save className="w-4 h-4" />
              <span>Save Settings</span>
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
