import { Bug, ShieldCheck, Activity, Github } from "lucide-react";

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      {/* Navbar */}
      <nav className="border-b bg-white dark:bg-gray-800 dark:border-gray-700 px-6 py-4 flex justify-between items-center">
        <div className="flex items-center space-x-2">
          <Bug className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
          <span className="font-bold text-xl tracking-tight">PR Bug Hunter</span>
        </div>
        <button className="flex items-center space-x-2 bg-gray-900 dark:bg-gray-700 text-white px-4 py-2 rounded-lg hover:bg-gray-800 transition-colors text-sm font-medium">
          <Github className="w-4 h-4" />
          <span>Login with GitHub</span>
        </button>
      </nav>

      {/* Dashboard Content */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">Overview of your PR analyses and blocked bugs.</p>
        </header>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl border dark:border-gray-700 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Total PRs Scanned</h3>
              <Activity className="w-5 h-5 text-blue-500" />
            </div>
            <p className="text-3xl font-bold mt-4">1,248</p>
            <span className="text-sm text-green-500 font-medium">+12% from last month</span>
          </div>

          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl border dark:border-gray-700 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Bugs Intercepted</h3>
              <Bug className="w-5 h-5 text-red-500" />
            </div>
            <p className="text-3xl font-bold mt-4">342</p>
            <span className="text-sm text-green-500 font-medium">Zero false positives</span>
          </div>

          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl border dark:border-gray-700 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Estimated Hours Saved</h3>
              <ShieldCheck className="w-5 h-5 text-emerald-500" />
            </div>
            <p className="text-3xl font-bold mt-4">684h</p>
            <span className="text-sm text-gray-500 dark:text-gray-400">Based on 2h/bug debug time</span>
          </div>
        </div>

        {/* Repositories */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b dark:border-gray-700">
            <h2 className="font-semibold text-lg">Active Repositories</h2>
          </div>
          <div className="divide-y dark:divide-gray-700">
            {[1, 2, 3].map((repo) => (
              <div key={repo} className="px-6 py-4 flex items-center justify-between">
                <div>
                  <h3 className="font-medium">acme-corp/frontend-app-{repo}</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Last scanned 2 hours ago</p>
                </div>
                <div className="flex items-center space-x-4">
                  <span className="px-3 py-1 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded-full text-xs font-medium">Active</span>
                  <button className="text-sm text-indigo-600 dark:text-indigo-400 font-medium hover:underline">Settings</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
