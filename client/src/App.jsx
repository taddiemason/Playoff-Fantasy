import { Routes, Route, Navigate } from 'react-router-dom'
import Navbar from './components/Navbar.jsx'
import Landing from './pages/Landing.jsx'
import Login from './pages/Login.jsx'
import Register from './pages/Register.jsx'
import Settings from './pages/Settings.jsx'
import Dashboard from './pages/Dashboard.jsx'
import CreateLeague from './pages/CreateLeague.jsx'
import LeagueHome from './pages/LeagueHome.jsx'
import TeamDetail from './pages/TeamDetail.jsx'
import Standings from './pages/Standings.jsx'
import LeagueRules from './pages/LeagueRules.jsx'
import AddPlayers from './pages/AddPlayers.jsx'
import PlayerExplorer from './pages/PlayerExplorer.jsx'
import CommissionerDashboard from './pages/CommissionerDashboard.jsx'
import JoinLeague from './pages/JoinLeague.jsx'
import SchedulePage from './pages/SchedulePage.jsx'
import LineupPage from './pages/LineupPage.jsx'
import MatchupPage from './pages/MatchupPage.jsx'
import WaiverWirePage from './pages/WaiverWirePage.jsx'
import TradesPage from './pages/TradesPage.jsx'
import DraftPage from './pages/DraftPage.jsx'
import AuctionPage from './pages/AuctionPage.jsx'
import KeepersPage from './pages/KeepersPage.jsx'
import ChatPage from './pages/ChatPage.jsx'
import LeagueLayout from './components/LeagueLayout.jsx'
import RequireAuth from './components/guards/RequireAuth.jsx'
import { useAuth } from './auth/AuthContext.jsx'

function Index() {
  const { user, loading } = useAuth()
  if (loading) return <div className="loading-state"><span className="loading-spinner"></span> Loading…</div>
  return user ? <Navigate to="/dashboard" replace /> : <Landing />
}

export default function App() {
  return (
    <div className="app">
      <Navbar />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/welcome" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
          <Route path="/join/:code" element={<JoinLeague />} />
          <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          <Route path="/leagues/new" element={<RequireAuth><CreateLeague /></RequireAuth>} />
          <Route path="/leagues/:leagueId" element={<LeagueLayout />}>
            <Route index element={<LeagueHome />} />
            <Route path="standings" element={<Standings />} />
            <Route path="rules" element={<LeagueRules />} />
            <Route path="players" element={<PlayerExplorer />} />
            <Route path="add-players" element={<AddPlayers />} />
            <Route path="admin" element={<CommissionerDashboard />} />
            <Route path="teams/:teamId" element={<TeamDetail />} />
            <Route path="schedule" element={<SchedulePage />} />
            <Route path="lineup" element={<LineupPage />} />
            <Route path="matchup" element={<MatchupPage />} />
            <Route path="waivers" element={<WaiverWirePage />} />
            <Route path="trades" element={<TradesPage />} />
            <Route path="draft" element={<DraftPage />} />
            <Route path="auction" element={<AuctionPage />} />
            <Route path="keepers" element={<KeepersPage />} />
            <Route path="chat" element={<ChatPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
