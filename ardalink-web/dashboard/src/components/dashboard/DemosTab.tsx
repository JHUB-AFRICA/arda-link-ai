import { Radio, ExternalLink } from "lucide-react";

/** Demo simulators tab with USSD, SMS, and Voice simulator links */
export function DemosTab() {
  return (
    <div className="flex-1 p-3 sm:p-6 overflow-y-auto">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
            <Radio className="w-5 h-5 text-purple-400" /> Demo Simulators
          </h2>
          <p className="text-sm text-gray-400">
            Test herder interaction channels without Africa's Talking dependency.
            All simulators use the same AI pipeline and live satellite data.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* USSD Simulator */}
          <a
            href="/api/demo/ussd/simulator"
            target="_blank"
            rel="noopener noreferrer"
            className="block bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-purple-600/50 hover:bg-gray-800/50 transition-all group"
          >
            <div className="w-12 h-12 rounded-xl bg-purple-900/30 border border-purple-700/50 flex items-center justify-center mb-4 group-hover:bg-purple-900/50 transition-colors">
              <span className="text-2xl">📱</span>
            </div>
            <h3 className="text-base font-semibold text-white mb-2">
              USSD Simulator
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              Test USSD menu flows with an interactive feature-phone simulator.
              Dial *123*8# to access herder intelligence.
            </p>
            <div className="flex items-center text-purple-400 text-sm font-medium">
              Open simulator
              <ExternalLink className="w-4 h-4 ml-1" />
            </div>
          </a>

          {/* SMS Simulator */}
          <a
            href="/api/demo/sms/simulator"
            target="_blank"
            rel="noopener noreferrer"
            className="block bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-blue-600/50 hover:bg-gray-800/50 transition-all group"
          >
            <div className="w-12 h-12 rounded-xl bg-blue-900/30 border border-blue-700/50 flex items-center justify-center mb-4 group-hover:bg-blue-900/50 transition-colors">
              <span className="text-2xl">💬</span>
            </div>
            <h3 className="text-base font-semibold text-white mb-2">SMS Simulator</h3>
            <p className="text-sm text-gray-400 mb-4">
              Test SMS keyword responses. Try BULA, MALISHO, ONGEA keywords
              for instant intelligence.
            </p>
            <div className="flex items-center text-blue-400 text-sm font-medium">
              Open simulator
              <ExternalLink className="w-4 h-4 ml-1" />
            </div>
          </a>

          {/* Voice Simulator */}
          <a
            href="/api/demo/voice/simulator"
            target="_blank"
            rel="noopener noreferrer"
            className="block bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-green-600/50 hover:bg-gray-800/50 transition-all group"
          >
            <div className="w-12 h-12 rounded-xl bg-green-900/30 border border-green-700/50 flex items-center justify-center mb-4 group-hover:bg-green-900/50 transition-colors">
              <span className="text-2xl">📞</span>
            </div>
            <h3 className="text-base font-semibold text-white mb-2">
              Voice Simulator
              <span className="ml-2 px-2 py-0.5 text-[10px] rounded-full bg-yellow-900/40 border border-yellow-700/50 text-yellow-300 font-medium">
                BETA
              </span>
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              Test voice conversation flows with simulated speech-to-text input
              and AI responses.
            </p>
            <div className="flex items-center text-green-400 text-sm font-medium">
              Open simulator
              <ExternalLink className="w-4 h-4 ml-1" />
            </div>
          </a>
        </div>

        {/* Demo Hub Link */}
        <div className="mt-6 p-4 bg-gray-900/50 border border-gray-800 rounded-xl">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold text-white mb-1">Demo Hub</h4>
              <p className="text-xs text-gray-500">
                Unified home for all simulators with detailed documentation
              </p>
            </div>
            <a
              href="/api/demo"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 hover:text-white transition-colors flex items-center gap-2"
            >
              Open Hub
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
