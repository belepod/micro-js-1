import React, { useState, useEffect } from 'react';
import { fetchTenants, createTenant, deleteTenant, renameTenant } from '../api';
import CreateTenantForm from './CreateTenantForm';
import { Link } from 'react-router-dom';

function DashboardPage() {
    const [tenants, setTenants] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);

    const loadTenants = async () => {
        setIsLoading(true);
        try {
            const response = await fetchTenants();
            setTenants(response.data);
        } catch (error) {
            console.error("Failed to fetch tenants", error);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadTenants();
    }, []);

    const handleCreateTenant = async (tenantData) => {
        try {
            await createTenant(tenantData);
            setShowForm(false);
            loadTenants(); // Refresh the list
        } catch (error) {
            alert(`Failed to create tenant: ${error.response?.data?.error || 'Server error'}`);
        }
    };

    const handleDelete = async (tenantId) => {
        if (window.confirm(`Are you sure you want to delete tenant '${tenantId}'? This is irreversible.`)) {
            await deleteTenant(tenantId);
            loadTenants();
        }
    };
    
    const handleRename = async (oldId) => {
        const newId = prompt(`Enter the new Tenant ID for '${oldId}':`);
        if (newId && newId !== oldId) {
            await renameTenant(oldId, newId);
            loadTenants();
        }
    };

    if (isLoading) return <p>Loading tenants...</p>;

    return (
        <div>
            <h2>All Tenants</h2>
            <button onClick={() => setShowForm(!showForm)}>
                {showForm ? 'Cancel' : '＋ Create New Tenant'}
            </button>
            
            {showForm && <CreateTenantForm onSubmit={handleCreateTenant} />}

            <table>
                <thead>
                    <tr>
                        <th>Tenant ID</th>
                        <th>Organization Name</th>
                        <th>Subdomain</th>
                        <th>Created At</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {tenants.map(tenant => (
                        <tr key={tenant.tenant_id}>
                            <td>{tenant.tenant_id}</td>
                            <td>{tenant.organization_name}</td>
                            <td>{tenant.subdomain}</td>
                            <td>{new Date(tenant.created_at).toLocaleString()}</td>
                            <td className="actions">
                                <button onClick={() => handleRename(tenant.tenant_id)}>Rename</button>
                                <button className="delete-btn" onClick={() => handleDelete(tenant.tenant_id)}>Delete</button>
                            </td>
                            <td>
                                 <Link to={`/tenants/${tenant.tenant_id}`}>{tenant.tenant_id}</Link>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default DashboardPage;
