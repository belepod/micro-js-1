import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './components/LoginPage';
import DashboardPage from './components/DashboardPage';
import TenantDetailsPage from './components/TenantDetailsPage';

function App() {
    const [isAuthenticated, setIsAuthenticated] = useState(!!document.cookie.includes('admin-session'));

    const handleLoginSuccess = () => {
        setIsAuthenticated(true);
    };

    return (
        <div className="container">
            <h1>Tenant Management Control Panel</h1>
            <Router>
                <Routes>
                    <Route
                        path="/login"
                        element={
                            isAuthenticated ? <Navigate to="/" /> : <LoginPage onLoginSuccess={handleLoginSuccess} />
                        }
                    />
                    <Route
                        path="/"
                        element={
                            isAuthenticated ? <DashboardPage /> : <Navigate to="/login" />
                        }
                    />
                    <Route
                        path="/tenants/:tenantId"
                        element={
                            isAuthenticated ? <TenantDetailsPage /> : <Navigate to="/login" />
                        }
                    />
                </Routes>
            </Router>
        </div>
    );
}

export default App;
