// Importação dos módulos necessários
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Inicialização do aplicativo Express
const app = express();
const port = 3002;

// --- DADOS EM MEMÓRIA PARA DESPESAS ---
// Em um projeto real, isso seria substituído por um banco de dados (SQLite, PostgreSQL, etc.)
let expenses = []; 
let nextExpenseId = 1;

// Configuração dos middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Validação da chave da API do Asaas
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
if (!ASAAS_API_KEY) {
    console.error("ERRO: A variável de ambiente ASAAS_API_KEY não está definida.");
    process.exit(1);
}

// Configuração do Axios para se comunicar com a API do Asaas
const asaasAPI = axios.create({
    baseURL: 'https://api.asaas.com/v3',
    headers: {
        'access_token': ASAAS_API_KEY,
        'Content-Type': 'application/json'
    }
});

// --- ROTAS DA API ---

// Rota para o Dashboard
app.get('/api/dashboard-summary', async (req, res) => {
    try {
        // 1. Buscar pagamentos do Asaas
        const { data: paymentsData } = await asaasAPI.get('/payments?limit=100');
        const payments = paymentsData.data || [];

        // 2. Calcular totais de receitas
        let totalRevenue = 0;
        const customerIds = new Set();
        const monthlyRevenue = {};

        payments.forEach(payment => {
            customerIds.add(payment.customer);
            if (payment.status === 'RECEIVED') {
                totalRevenue += payment.value;
                const paymentMonth = payment.paymentDate.substring(0, 7); // Formato "YYYY-MM"
                monthlyRevenue[paymentMonth] = (monthlyRevenue[paymentMonth] || 0) + payment.value;
            }
        });
        
        // 3. Calcular totais de despesas
        const totalExpenses = expenses.reduce((sum, exp) => sum + exp.value, 0);
        const expenseByCategory = expenses.reduce((acc, exp) => {
            acc[exp.category] = (acc[exp.category] || 0) + exp.value;
            return acc;
        }, {});


        // 4. Preparar dados para os gráficos
        const evolutionChartLabels = [];
        const evolutionChartData = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            const monthKey = d.toISOString().substring(0, 7);
            evolutionChartLabels.push(new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(d));
            evolutionChartData.push(monthlyRevenue[monthKey] || 0);
        }

        const expenseChartLabels = Object.keys(expenseByCategory);
        const expenseChartData = Object.values(expenseByCategory);
        
        // 5. Enviar resumo completo
        res.json({
            totalRevenue,
            totalExpenses,
            netProfit: totalRevenue - totalExpenses,
            totalCustomers: customerIds.size,
            evolutionChart: {
                labels: evolutionChartLabels,
                data: evolutionChartData
            },
            expenseChart: {
                labels: expenseChartLabels,
                data: expenseChartData
            }
        });

    } catch (error) {
        console.error('Erro ao buscar resumo do dashboard:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao buscar resumo do dashboard.' });
    }
});


// Rota para obter o status de todos os alunos
app.get('/api/students-status', async (req, res) => {
    try {
        const { data: customersData } = await asaasAPI.get('/customers?limit=100');
        const customers = customersData.data || [];

        if (customers.length === 0) {
            return res.json({ students: [] });
        }

        const studentStatusPromises = customers.map(async (customer) => {
            const { data: paymentsData } = await asaasAPI.get(`/payments?customer=${customer.id}`);
            const payments = paymentsData.data || [];
            
            let status = 'ADIMPLENTE';
            let nextDueDate = 'N/A';
            let monthlyFee = 0;

            const hasOverdue = payments.some(p => p.status === 'OVERDUE');
            if (hasOverdue) {
                status = 'INADIMPLENTE';
            }
            
            const pendingPayments = payments.filter(p => p.status === 'PENDING' || p.status === 'OVERDUE').sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
            
            if (pendingPayments.length > 0) {
                nextDueDate = pendingPayments[0].dueDate;
                monthlyFee = pendingPayments[0].value;
            } else if (payments.length > 0) {
                const lastPayment = payments.sort((a, b) => new Date(b.paymentDate || b.dueDate) - new Date(a.paymentDate || a.dueDate))[0];
                monthlyFee = lastPayment.value;
                nextDueDate = 'Em dia';
            } else {
                 nextDueDate = 'Sem cobranças';
            }

            return { id: customer.id, name: customer.name, status, nextDueDate, monthlyFee };
        });

        const students = await Promise.all(studentStatusPromises);
        res.json({ students });

    } catch (error) {
        console.error('Erro ao obter status dos alunos:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao obter status dos alunos.' });
    }
});

// Rota para criar um novo cliente e uma cobrança
app.post('/api/create-customer-and-payment', async (req, res) => {
    const { name, cpfCnpj, value, dueDate } = req.body;
    if (!name || !cpfCnpj || !value || !dueDate) {
        return res.status(400).json({ message: "Todos os campos são obrigatórios." });
    }
    try {
        const customerResponse = await asaasAPI.post('/customers', { name, cpfCnpj });
        const customerId = customerResponse.data.id;

        const paymentResponse = await asaasAPI.post('/payments', {
            customer: customerId,
            billingType: 'BOLETO',
            value,
            dueDate,
            description: `Mensalidade da creche para ${name}`
        });

        res.status(201).json({ 
            customer: customerResponse.data, 
            payment: paymentResponse.data 
        });
    } catch (error) { // A CHAVE '}' FALTANTE FOI ADICIONADA AQUI
        console.error('Erro ao criar cliente ou pagamento:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao processar a criação no Asaas.', details: error.response?.data });
    }
});


// Rota para gerar relatório de receitas
app.get('/api/revenue-report', async (req, res) => {
    try {
        const { data: customersData } = await asaasAPI.get('/customers?limit=100');
        const customers = customersData.data || [];
        const customerMap = new Map(customers.map(c => [c.id, c.name]));

        const { data: paymentsData } = await asaasAPI.get('/payments?status=RECEIVED&limit=100');
        const receivedPayments = paymentsData.data || [];

        const reportData = receivedPayments.map(payment => ({
            id: payment.id,
            customerName: customerMap.get(payment.customer) || 'Cliente não encontrado',
            value: payment.value,
            paymentDate: payment.paymentDate,
            description: payment.description
        }));
        res.json({ report: reportData });
    } catch (error) {
        console.error('Erro ao gerar relatório de receitas:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao gerar relatório de receitas.' });
    }
});

// Rota para criar uma nova receita avulsa
app.post('/api/create-revenue', async (req, res) => {
    const { customerId, description, value, dueDate, category } = req.body;
    if (!customerId || !description || !value || !dueDate) {
        return res.status(400).json({ message: "Todos os campos da receita são obrigatórios." });
    }
    try {
        const paymentResponse = await asaasAPI.post('/payments', {
            customer: customerId,
            billingType: 'BOLETO',
            value,
            dueDate,
            description: `[${category || 'Avulso'}] ${description}`
        });
        res.status(201).json({ payment: paymentResponse.data });
    } catch (error) {
        console.error('Erro ao criar nova receita:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao criar nova receita no Asaas.', details: error.response?.data });
    }
});


// --- ROTAS PARA DESPESAS (CRUD em memória) ---

// Listar todas as despesas
app.get('/api/expenses', (req, res) => {
    res.json({ expenses });
});

// Adicionar uma nova despesa
app.post('/api/expenses', (req, res) => {
    const { description, value, category, date } = req.body;
    if (!description || !value || !category || !date) {
        return res.status(400).json({ message: "Todos os campos da despesa são obrigatórios." });
    }
    const newExpense = {
        id: nextExpenseId++,
        description,
        value: parseFloat(value),
        category,
        date
    };
    expenses.push(newExpense);
    res.status(201).json(newExpense);
});

// Inicia o servidor
app.listen(port, () => {
    console.log(`🚀 Servidor rodando na porta ${port}`);
});

