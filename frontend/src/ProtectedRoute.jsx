// src/ProtectedRoute.jsx
import React from 'react';
import { Navigate } from 'react-router-dom';
import PropTypes from 'prop-types';

export default function ProtectedRoute({ children, allowedRole }) {
  let user;

  try {
    const userData = localStorage.getItem('user');
    user = userData ? JSON.parse(userData) : null;
  } catch (err) {
    console.error('Failed to parse user from localStorage:', err);
    localStorage.removeItem('user');
    return <Navigate to="/auth" replace />;
  }

  // Not logged in
  if (!user || !user.role) {
    console.warn('No user found or role missing. Redirecting...');
    return <Navigate to="/auth" replace />;
  }

  // Role mismatch
  if (allowedRole && user.role !== allowedRole) {
    console.warn(`Access denied: User role "${user.role}" does not match allowed role "${allowedRole}".`);
    return <Navigate to="/auth" replace />;
  }

  // Authorized
  return children;
}

ProtectedRoute.propTypes = {
  children: PropTypes.node.isRequired,
  allowedRole: PropTypes.string,
};

ProtectedRoute.defaultProps = {
  allowedRole: null,
};