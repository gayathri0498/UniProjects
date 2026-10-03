// src/AppRoutes.jsx
import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

import App from './App'; // Public dashboard
import Auth from './Auth';
import AdminDashboard from './AdminDashboard';
import HospitalDashboard from './HospitalDashboard';
import ProtectedRoute from './ProtectedRoute';

function getUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}

function renderAuthOrRedirect() {
  const user = getUser();
  if (user && user.role) {
    return (
      <Navigate
        to={user.role === 'admin' ? '/admin-dashboard' : '/hospital-dashboard'}
        replace
      />
    );
  }
  return <Auth />;
}

// Smart redirect that sends users to the appropriate dashboard.
// If not logged in, send to /auth.
function DashboardRedirect() {
  const user = getUser();
  if (!user?.role) return <Navigate to="/auth" replace />;
  return (
    <Navigate
      to={user.role === 'admin' ? '/admin-dashboard' : '/hospital-dashboard'}
      replace
    />
  );
}

// Simple logout route – clears local state and goes home.
function Logout() {
  try {
    localStorage.removeItem('user');
  } catch {}
  return <Navigate to="/" replace />;
}

function NotFound() {
  return (
    <h2 style={{ textAlign: 'center', marginTop: '2rem' }}>
      404 – Page Not Found
    </h2>
  );
}

export default function AppRoutes() {
  return (
    <Routes>
      {/* Public Dashboard */}
      <Route path="/" element={<App />} />

      {/* Auth Route: if already logged in, jump to role dashboard */}
      <Route path="/auth" element={renderAuthOrRedirect()} />

      {/* Quick role-based redirect */}
      <Route path="/dashboard" element={<DashboardRedirect />} />

      {/* Admin aliases */}
      <Route path="/admin" element={<Navigate to="/admin-dashboard" replace />} />
      <Route
        path="/admin-dashboard"
        element={
          <ProtectedRoute allowedRole="admin">
            <AdminDashboard />
          </ProtectedRoute>
        }
      />

      {/* Hospital aliases */}
      <Route path="/hospital" element={<Navigate to="/hospital-dashboard" replace />} />
      <Route
        path="/hospital-dashboard"
        element={
          <ProtectedRoute allowedRole="hospital">
            <HospitalDashboard />
          </ProtectedRoute>
        }
      />

      {/* Logout helper */}
      <Route path="/logout" element={<Logout />} />

      {/* Fallback */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}